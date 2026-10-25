/**
 * lib/allowlist.js — 白名单解析（P11）
 *
 * 静态白名单只能填死 BV / uid，等于永远只能回同几个人。
 * 这里加「动态条目」：把「谁找过我」变成可用的放行依据。
 *
 * 支持的 scope 条目：
 *   BV1xxxx          —— 具体视频
 *   uid:12345        —— 具体用户
 *   room:999         —— 直播间
 *   reply-to-me      —— **任何回复过/ @过她的人**（动态，从 msgfeed 水位推导）
 *   my-followers     —— 预留（需要额外接口，暂不实现）
 *
 * 设计立场：
 *   动态条目仍然是**确定性规则**——名单来自「确实有人来找过她」这个事实，
 *   不是模型临时判断。放行权没有交回 LLM。
 */

import fs from "node:fs";
import path from "node:path";

const STATE = "msgfeed-state.json";
const KNOWN = "known-people.json";

/** 是否包含某个动态条目 */
export function hasDynamic(scope, name) {
  return Array.isArray(scope) && scope.some((s) => String(s).trim().toLowerCase() === name);
}

/** 读已知的人（由 msgfeed 轮询时累积） */
export function readKnown(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, KNOWN), "utf8"));
    return Array.isArray(j?.people) ? j.people : [];
  } catch {
    return [];
  }
}

/** 记一批来找过她的人（去重、留最近 200） */
export function rememberPeople(dataDir, people = []) {
  const cur = readKnown(dataDir);
  const map = new Map(cur.map((p) => [String(p.mid), p]));
  for (const p of people) {
    const mid = String(p?.mid || "");
    if (!mid) continue;
    map.set(mid, {
      mid,
      name: String(p.name || map.get(mid)?.name || ""),
      lastSeen: new Date().toISOString(),
      times: Number(map.get(mid)?.times || 0) + 1,
    });
  }
  const list = [...map.values()]
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    .slice(0, 200);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, KNOWN), JSON.stringify({ people: list }, null, 2) + "\n");
  } catch { /* 写失败不影响放行判断 */ }
  return list;
}

/**
 * 判断一个目标是否被白名单放行。
 *
 * @param {object} opts
 *   scope   配置里的白名单数组
 *   target  目标字符串，如 "BV1xx" / "uid:123" / "room:9"
 *   dataDir 用于读动态名单
 * @returns {{allowed:boolean, reason:string, by?:string}}
 */
export function allows({ scope = [], target = "", dataDir = "" } = {}) {
  const list = (Array.isArray(scope) ? scope : []).map((s) => String(s).trim()).filter(Boolean);

  if (list.length === 0) {
    return { allowed: false, reason: "白名单为空 → 不向任何目标发言" };
  }
  if (!target) {
    return { allowed: false, reason: "目标为空，无法判断" };
  }

  // 1. 静态条目：完全相等 或 前缀匹配（uid:123 匹配 uid:123）
  for (const s of list) {
    if (target === s) return { allowed: true, reason: `命中静态条目 ${s}`, by: s };
    if (target.startsWith(s + ":")) return { allowed: true, reason: `命中静态条目 ${s}`, by: s };
  }

  // 2. 动态：reply-to-me —— 目标是 uid:xxx 且这个人找过她
  if (hasDynamic(list, "reply-to-me")) {
    const m = /^uid:(\d+)$/.exec(target);
    if (m) {
      const mid = m[1];
      const known = readKnown(dataDir);
      const hit = known.find((p) => String(p.mid) === mid);
      if (hit) {
        return { allowed: true, reason: `命中 reply-to-me（${hit.name || mid} 曾找过她）`, by: "reply-to-me" };
      }
      return { allowed: false, reason: `reply-to-me：uid:${mid} 没找过她` };
    }
    // 目标是 BV 时，reply-to-me 不适用
    return { allowed: false, reason: `reply-to-me 只放行 uid: 目标，当前 ${target}` };
  }

  return { allowed: false, reason: `目标 ${target} 不在白名单内`, by: null };
}

/** 白名单可读说明（给 UI / 工具用） */
export function describe(scope = [], dataDir = "") {
  // scope 可能是数组，也可能是配置文件里那种「逗号分隔的字符串」。
  // 只认数组的话，直接读 config.json 的调用方会拿到空列表（界面白名单永远是 0）。
  const raw = Array.isArray(scope)
    ? scope
    : String(scope || "").split(",");
  const list = raw.map((s) => String(s).trim()).filter(Boolean);
  const known = readKnown(dataDir);
  return {
    scope: list,
    // 给界面用的别名（前端读的是 static）
    static: list,
    dynamic: {
      replyToMe: hasDynamic(list, "reply-to-me"),
      knownPeople: known.length,
      recent: known.slice(0, 5).map((p) => ({ mid: p.mid, name: p.name, times: p.times })),
      list: known.map((p) => ({ uid: p.mid, name: p.name })),
    },
  };
}

/** 清空已知名单 */
export function forgetPeople(dataDir) {
  try { fs.unlinkSync(path.join(dataDir, KNOWN)); } catch { /* 不存在 */ }
  return { ok: true };
}
