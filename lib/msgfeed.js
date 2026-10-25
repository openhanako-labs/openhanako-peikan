/**
 * lib/msgfeed.js — 收件箱监听（P8）
 *
 * 两个箱子：`reply`（回复我的）/ `at`（@我的）。
 *
 * ⚠️ 已知坑（来自 whale 的实测记录）：
 *   1. `/x/msgfeed/reply` 的 `item.title` **不可靠**——多条可能是同一句，
 *      真正正文在 `source_content`。所以正文优先取 source_content。
 *   2. 翻页时 cursor 会返回重叠数据（每条出现两遍）→ 必须按 id 去重。
 *   3. 收件箱只用来「发现有人找我」，正文以 source_content 为准。
 *
 * 读，不写。监听 ≠ 自动回复。
 */

import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";
import * as notify from "./notify.js";
import * as allowlist from "./allowlist.js";

const STATE = "msgfeed-state.json";

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, STATE), "utf8")); }
  catch { return { reply: 0, at: 0, lastPollAt: null }; }
}

function writeState(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, STATE), JSON.stringify(st, null, 2) + "\n");
  } catch { /* 状态写失败不影响本轮 */ }
}

/** 拉一个箱子，按 id 去重 */
async function pull(kind, { fetchImpl, headers, pages = 1 }) {
  const out = [];
  let cursor = "";
  let lastView = 0;

  for (let p = 0; p < pages; p += 1) {
    const u = `https://api.bilibili.com/x/msgfeed/${kind}?platform=web&build=0&mobi_app=web` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    let j;
    try {
      const r = await fetchImpl(u, { method: "GET", headers });
      j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    } catch (e) {
      return { ok: false, items: [], error: String(e && e.message ? e.message : e) };
    }
    if (j?.code !== 0) return { ok: false, items: [], error: `code=${j?.code} ${j?.message || ""}` };

    if (p === 0) lastView = Number(j?.data?.last_view_at ?? 0);
    const items = j?.data?.items ?? [];
    for (const it of items) {
      out.push({
        kind,
        id: String(it.id ?? ""),
        t: Number(it.reply_time ?? it.at_time ?? 0),
        who: it.user?.nickname ?? "?",
        mid: String(it.user?.mid ?? ""),
        // ⚠️ title 不可靠；正文优先 source_content
        title: String(it.item?.title ?? ""),
        source: String(it.item?.source_content ?? ""),
        target: String(it.item?.target_reply_content ?? ""),
        oid: String(it.item?.subject_id ?? ""),
        root: String(it.item?.root_id ?? ""),
        parent: String(it.item?.source_id ?? ""),
        uri: String(it.item?.uri ?? ""),
        // 楼层类型：11 = 动态/图文，其余当视频
        business: Number(it.item?.business_id ?? 1),
      });
    }
    cursor = j?.data?.cursor ?? "";
    if (!cursor || items.length === 0) break;
  }

  // 翻页重叠去重
  const seen = new Set();
  const uniq = out.filter((x) => {
    if (!x.id || seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
  return { ok: true, items: uniq, lastView };
}

/** 取一条的正文（source_content 优先，退回 title） */
export function bodyOf(item) {
  const t = String(item?.source || "").trim() || String(item?.title || "").trim();
  return t.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * 回读楼层拿真实正文。
 *
 * 为什么要这一步（参考 dsh-bili-whale 的实测）：
 *   `/x/msgfeed/reply` 的 item.title **不总是**那条新回复的正文，
 *   实测多条 item 的 title 是同一句（往往是原楼层内容）。
 *   收件箱只适合「发现有人找我们」，正文以楼层为准。
 *
 * @returns {Promise<{rpid,text,ctime,exact}|null>}
 */
export async function resolveReply(sdk, { business = 1, oid, root, mid, parentRpid, headers } = {}) {
  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") return null;
  if (!oid || !root) return null;

  const type = Number(business) === 11 ? 11 : 1;
  const reps = [];
  for (let pn = 1; pn <= 6; pn += 1) {
    const u = `https://api.bilibili.com/x/v2/reply/reply?type=${type}&oid=${oid}&root=${root}&ps=20&pn=${pn}`;
    let j;
    try {
      const r = await fetchImpl.call(sdk.network, u, { method: "GET", headers });
      j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    } catch {
      return null;
    }
    if (!j || j.code !== 0) return null;
    const page = j?.data?.replies ?? [];
    reps.push(...page);
    if (page.length < 20) break;
  }

  const mine = mid ? reps.filter((r) => String(r.mid) === String(mid)) : reps;
  if (!mine.length) return null;

  let pick = null;
  if (parentRpid) {
    pick = [...mine].reverse().find((r) => String(r.parent) === String(parentRpid)) ?? null;
  }
  const exact = Boolean(pick);
  if (!pick) pick = mine[mine.length - 1];
  if (!pick) return null;

  return {
    rpid: String(pick.rpid ?? ""),
    text: String(pick.content?.message ?? "").replace(/\s+/g, " ").slice(0, 500),
    ctime: Number(pick.ctime ?? 0),
    exact,
  };
}

/**
 * 拉一次收件箱（不通知，只返回）。
 */
export async function poll(sdk, dataDir, { pages = 1, baseHeaders } = {}) {
  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, error: "宿主未提供 network.fetch" };

  const headers = baseHeaders || {};
  const [reply, at] = await Promise.all([
    pull("reply", { fetchImpl: fetchImpl.bind(sdk.network), headers, pages }),
    pull("at", { fetchImpl: fetchImpl.bind(sdk.network), headers, pages }),
  ]);

  const errors = [];
  if (!reply.ok) errors.push(`回复收件箱：${reply.error}`);
  if (!at.ok) errors.push(`@收件箱：${at.error}`);

  const all = [...(reply.items || []), ...(at.items || [])].sort((a, b) => a.t - b.t);
  const lastView = Math.max(reply.lastView || 0, at.lastView || 0);

  return { ok: errors.length === 0, items: all, lastView, errors };
}

/**
 * 拉一次并找出「新的」（比上次记录的时间新）。
 * 有新的 → 写笔记 + 通知（只报一次，不刷屏）。
 *
 * @returns {Promise<{ok:boolean, fresh:Array, total:number, error?:string}>}
 */
export async function pollAndNotify(sdk, dataDir, opts = {}) {
  const st = readState(dataDir);
  const r = await poll(sdk, dataDir, opts);
  if (!r.ok && !r.items?.length) {
    writeState(dataDir, { ...st, lastPollAt: new Date().toISOString() });
    return { ok: false, fresh: [], total: 0, error: (r.errors || []).join("；") };
  }

  const since = Math.max(Number(st.reply || 0), Number(st.at || 0));
  const fresh = (r.items || []).filter((x) => x.t > since);

  // 记住来找过她的人（供 reply-to-me 白名单用）
  if ((r.items || []).length) {
    allowlist.rememberPeople(dataDir, (r.items || []).map((x) => ({ mid: x.mid, name: x.who })));
  }

  writeState(dataDir, {
    reply: Math.max(Number(st.reply || 0), ...(r.items || []).filter((x) => x.kind === "reply").map((x) => x.t), 0),
    at: Math.max(Number(st.at || 0), ...(r.items || []).filter((x) => x.kind === "at").map((x) => x.t), 0),
    lastPollAt: new Date().toISOString(),
  });

  if (fresh.length) {
    // 落笔记（她自己的记录）
    for (const x of fresh.slice(0, 10)) {
      const body = bodyOf(x);
      try {
        store.addNote(dataDir, {
          source: x.uri || `uid:${x.mid}`,
          kind: x.kind === "at" ? "mention" : "reply",
          summary: `${x.who}：${body || "（无正文）"}`,
          marks: [x.kind === "at" ? "@我" : "回复我"],
        });
      } catch { /* 笔记失败不影响通知 */ }
    }

    // 通知（只说人数，不刷屏）
    const whoList = Array.from(new Set(fresh.map((x) => x.who))).slice(0, 3);
    const more = fresh.length > whoList.length ? ` 等 ${fresh.length} 条` : "";
    try {
      await notify.push(sdk, dataDir, {
        title: "奥菲莉娅 · 有人找你",
        body: `${whoList.join("、")}${more}\n${bodyOf(fresh[fresh.length - 1]).slice(0, 80)}`,
      });
    } catch { /* 通知失败不影响监听 */ }
  }

  return { ok: true, fresh, total: (r.items || []).length };
}

/** 读监听状态 */
export function status(dataDir) {
  const st = readState(dataDir);
  return {
    lastPollAt: st.lastPollAt || null,
    replySeenAt: st.reply || 0,
    atSeenAt: st.at || 0,
  };
}

/** 手动把水位推到最新（不想被历史消息打扰时用） */
export function markAllSeen(dataDir) {
  const st = readState(dataDir);
  const now = Math.floor(Date.now() / 1000);
  writeState(dataDir, { ...st, reply: now, at: now, lastPollAt: new Date().toISOString() });
  return { ok: true, markedAt: now };
}

/**
 * 把水位推到给定条目里最新的时间。
 * 与 markAllSeen 的区别：只推进到真实收到的那些，不凭空跳到 now。
 */
export function advanceWater(dataDir, items = []) {
  const st = readState(dataDir);
  const replyMax = Math.max(0, ...items.filter((x) => x.kind === "reply").map((x) => Number(x.t) || 0));
  const atMax = Math.max(0, ...items.filter((x) => x.kind === "at").map((x) => Number(x.t) || 0));
  writeState(dataDir, {
    ...st,
    reply: Math.max(Number(st.reply || 0), replyMax),
    at: Math.max(Number(st.at || 0), atMax),
    lastPollAt: new Date().toISOString(),
  });
  return { ok: true };
}
