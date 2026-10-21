/**
 * lib/risk.js — 风控熔断
 *
 * 为什么要有这个（2026-10-20）：
 *   源仓库 dsh-bili-whale 的 comment.mjs 里写着：
 *     "12015: 需要评论验证码（说明被风控盯上了，停手）"
 *     "否则 agent 会把「被风控拒了」当成「发成功了」，
 *      绕过了「撞风控立刻停手」的红线"
 *
 *   我这边只判 `code === 0`，被限流了就当成普通失败，下一轮接着撞。
 *   撞多了号会废。这是所有缺口里最危险的一个。
 *
 * 三种状态：
 *   · 正常      —— 不拦
 *   · 冷却中    —— 收到风控码，一段时间内禁止一切写操作
 *   · 需人工    —— 需要验证码之类的，只能人去处理，冷却期内不自愈
 */
import fs from "node:fs";
import path from "node:path";

const STATE = "risk-state.json";

/** B站 风控相关错误码 → 人话 + 是否需要人工 */
const RISK_CODES = {
  412: { level: "cooldown", hours: 6, note: "被限流（412）。风控盯上了，停手。" },
  "-352": { level: "cooldown", hours: 3, note: "风控校验失败（-352）。多半是请求太密。" },
  "-412": { level: "cooldown", hours: 6, note: "被限流（-412）。" },
  12015: { level: "manual", hours: 24, note: "需要评论验证码（12015）。这个只能人去点，冷却期内不自愈。" },
  12016: { level: "manual", hours: 24, note: "需要验证码（12016）。只能人去处理。" },
  "-101": { level: "manual", hours: 0, note: "登录态失效（-101）。需要重新登录。" },
  65004: { level: "ignore", hours: 0, note: "已取消赞 / 重复操作，不算风控" },
  65006: { level: "ignore", hours: 0, note: "重复点赞，不算风控" },
  "-404": { level: "ignore", hours: 0, note: "找不到目标，不是风控" },
  404: { level: "ignore", hours: 0, note: "找不到目标，不是风控" },
  "-400": { level: "ignore", hours: 0, note: "参数错，不是风控" },
};

function p(dataDir) {
  return path.join(dataDir, STATE);
}

function readState(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(p(dataDir), "utf8"));
    return {
      until: Number(j.until || 0),
      level: String(j.level || "normal"),
      note: String(j.note || ""),
      code: j.code ?? null,
      at: String(j.at || ""),
      hits: Number(j.hits || 0),
    };
  } catch {
    return { until: 0, level: "normal", note: "", code: null, at: "", hits: 0 };
  }
}

function writeState(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(p(dataDir), JSON.stringify(st, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** 查这个 code 是不是风控 */
export function classify(code) {
  const k = String(code);
  return RISK_CODES[k] || null;
}

/**
 * 当前能不能写。
 * @returns {{ok:boolean, level:string, note:string, remainMs:number}}
 */
export function check(dataDir) {
  const st = readState(dataDir);
  const now = Date.now();
  if (st.until > now) {
    const remainMs = st.until - now;
    const mins = Math.ceil(remainMs / 60000);
    return {
      ok: false,
      level: st.level,
      note: st.note || `冷却中（还剩 ${mins} 分钟）`,
      remainMs,
      code: st.code,
    };
  }
  // 冷却过期：manual 级别不自动恢复，要人清
  //
  // 2026-10-20 修：以前写的是 `st.until > 0 && st.until <= now`，
  // 而 -101（登录失效）的 hours 是 0 → until 写 0 → 这个守卫永远不成立，
  // 于是「需重新登录」这条提示也废了。
  // 现在：只要 level 是 manual 就拦，不管 until 是多少。
  if (st.level === "manual") {
    return {
      ok: false,
      level: "manual",
      note: st.note || "需要人工处理（重新登录或过验证码）",
      remainMs: Math.max(0, st.until - now),
      code: st.code,
      needsHuman: true,
    };
  }
  return { ok: true, level: "normal", note: "", remainMs: 0 };
}

/**
 * 记一次失败。只有风控类 code 才会真的拉闸。
 *
 * 这是「撞风控立刻停手」的落点：任何写通道拿到 code 都该先喂进来。
 *
 * @returns {{tripped:boolean, level?:string, until?:number, note?:string}}
 */
export function record(dataDir, code, { where = "" } = {}) {
  const c = classify(code);
  if (!c) return { tripped: false };
  if (c.level === "ignore") return { tripped: false, note: c.note };

  const hours = Number(c.hours) || 0;
  const until = hours > 0 ? Date.now() + hours * 3600 * 1000 : 0;

  const prev = readState(dataDir);
  const st = {
    until,
    level: c.level,
    note: c.note,
    code,
    at: new Date().toISOString(),
    hits: Number(prev.hits || 0) + 1,
  };
  writeState(dataDir, st);

  return {
    tripped: true,
    level: c.level,
    until,
    note: `${c.note}${where ? `（${where}）` : ""}`,
  };
}

/** 人工清闸（验证码过了 / 重新登录了） */
export function clear(dataDir) {
  writeState(dataDir, { until: 0, level: "normal", note: "", code: null, at: new Date().toISOString(), hits: 0 });
  return { ok: true };
}

/** 给界面看 */
export function status(dataDir) {
  const st = readState(dataDir);
  const c = check(dataDir);
  return {
    ok: c.ok,
    level: c.level,
    note: c.note,
    code: c.code,
    hits: st.hits,
    at: st.at,
    untilAt: st.until ? new Date(st.until).toISOString() : null,
    remainMinutes: Math.ceil(c.remainMs / 60000),
  };
}
