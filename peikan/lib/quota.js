/**
 * lib/quota.js — 配额账（P4：照原仓库语义重做）
 *
 * 补齐三件事：
 *   1. **fail-closed**：账本存在但读不出来 = 状态未知 → 拒绝发言（不是重置额度）
 *   2. **白名单 scope**：发言只在白名单内允许（uid: / room: / BV）
 *   3. **本地日期**：账本 at 存 UTC ISO，比较时必须先转本地日期
 *      （否则本地 00:00-08:00 发的会被算成昨天，凌晨窗口正好踩这个洞）
 *
 * 账本：<dataDir>/quota.json  { log: [{ at, type, target, note, share? }] }
 */

import fs from "node:fs";
import path from "node:path";
import * as allowlist from "./allowlist.js";

const FILE = "quota.json";
const today = () => new Date().toLocaleDateString("sv-SE");
/** UTC ISO → 本地日期（关键：不能拿本地日期直接 startsWith UTC 串） */
const dayOf = (at) => { try { return new Date(at).toLocaleDateString("sv-SE"); } catch { return ""; } };

// ── 上限（默认值，可被 config 覆盖）─────────────────────────────────
export const DEFAULTS = {
  comment: 2,     // 普通发言/天
  dynamic: 1,
  dm: 3,
  follow: 3,      // 关注/天（对外可见动作，单独计数）
  like: 5,        // 点赞/天（最轻的对外动作，但也不能无限）
  shareDaily: 3,  // 分享型/天（与 comment 分开记账）
  sameTargetDays: 7,
};

/**
 * 读账本。
 * ⚠️ fail-closed：文件存在但坏 → `{ corrupt: true }`，调用方必须拒绝发言。
 */
function readRaw(dataDir) {
  const p = path.join(dataDir, FILE);
  if (!fs.existsSync(p)) {
    return { log: [], corrupt: false, fresh: true };  // 全新安装 ≠ 坏文件
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { log: Array.isArray(j?.log) ? j.log : [], corrupt: false };
  } catch {
    return { log: [], corrupt: true };  // 状态未知
  }
}

function writeLog(dataDir, log) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify({ log }, null, 2) + "\n");
  } catch { /* 记账失败不影响已发出的动作 */ }
}

/**
 * 发前检查。
 * @param {object} opts { type, target, share, config }
 * @returns {{ok:boolean, reason?:string, corrupt?:boolean}}
 */
export function check(dataDir, { type, target = "", share = false, config = {} } = {}) {
  const { log, corrupt } = readRaw(dataDir);

  // 1. fail-closed：账本坏了就不发
  if (corrupt) {
    return { ok: false, corrupt: true, reason: "配额账本损坏，状态未知 → 拒绝发言（fail-closed）" };
  }

  // 2. 白名单：不在名单内一律拒（空名单 = 谁都不发）
  //    支持动态条目 reply-to-me（谁找过她）——但仍是确定性规则，不交 LLM 判断
  const scope = Array.isArray(config.scope) ? config.scope.filter(Boolean) : [];
  if (scope.length === 0) {
    return { ok: false, reason: "白名单为空 → 不向任何目标发言（先在设置里加 scope）" };
  }
  if (target) {
    const a = allowlist.allows({ scope, target, dataDir });
    if (!a.allowed) return { ok: false, reason: a.reason };
  }

  // 3. 每日条数（按类型分开计——之前把所有非分享混在一起，
  //    导致「赞一次扣评论额度」这类串行，多类型一上线就露馅）
  const caps = { ...DEFAULTS, ...(config.quota || {}) };
  const used = log.filter((x) => dayOf(x.at) === today() && (
    share ? x.share === true : (!x.share && x.type === type)
  )).length;
  const cap = share ? Number(caps.shareDaily) : Number(caps[type] ?? 0);
  if (!Number.isFinite(cap) || cap <= 0) {
    return { ok: false, reason: `类型 ${type}${share ? "(share)" : ""} 无限额配置 → 默认拦` };
  }
  if (used >= cap) {
    return { ok: false, reason: `${share ? "分享" : type} 今日已达上限 ${cap}` };
  }

  // 4. 同一目标 N 天内一次（仅分享型）
  if (share && target) {
    const days = Number(caps.sameTargetDays ?? 7);
    const cutoff = Date.now() - days * 86400000;
    const dup = log.some((x) => x.share && x.target === target && new Date(x.at).getTime() > cutoff);
    if (dup) return { ok: false, reason: `同一目标 ${target} 在 ${days} 天内已发过` };
  }

  return { ok: true };
}

/** 发后记账。at 存 UTC ISO，比较时再转本地日期。 */
export function record(dataDir, { type, target = "", note = "", share = false } = {}) {
  const { log } = readRaw(dataDir);
  log.push({
    at: new Date().toISOString(),   // UTC；dayOf() 负责转本地
    type,
    target,
    note: String(note).slice(0, 40),
    share: Boolean(share),
  });
  // 只留最近 500 条，别把文件养大
  writeLog(dataDir, log.slice(-500));
}

/** 查余量。账本坏时明确报告，不假装有额度。 */
export function status(dataDir, config = {}) {
  const { log, corrupt } = readRaw(dataDir);
  const caps = { ...DEFAULTS, ...(config.quota || {}) };
  const scope = Array.isArray(config.scope) ? config.scope.filter(Boolean) : [];

  const usedOf = (share) => log.filter((x) => dayOf(x.at) === today() && (share ? x.share === true : !x.share)).length;

  const out = {};
  for (const k of ["comment", "dynamic", "dm", "follow", "like"]) {
    const used = usedOf(false) && k === "comment" ? usedOf(false) : usedOf(false);
    // 逐类型统计
    const byType = log.filter((x) => dayOf(x.at) === today() && !x.share && x.type === k).length;
    out[k] = { used: byType, cap: Number(caps[k] ?? 0), left: Math.max(0, Number(caps[k] ?? 0) - byType) };
  }
  const shareUsed = usedOf(true);
  out.share = { used: shareUsed, cap: Number(caps.shareDaily ?? 0), left: Math.max(0, Number(caps.shareDaily ?? 0) - shareUsed) };

  return {
    day: today(),
    corrupt,
    caps: out,
    sameTargetDays: Number(caps.sameTargetDays ?? 7),
    scope,
  };
}
