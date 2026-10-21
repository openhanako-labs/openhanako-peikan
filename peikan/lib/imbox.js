/**
 * lib/imbox.js — 读 B站 私信（P19）
 *
 * 为什么必须补：她的「听」一直只覆盖评论回复和 @。
 * 私信那条路只能发不能收——你私信她，她永远不知道。
 * 这不是「少一个功能」，是「她不在场」。
 *
 * 接口（实测 2026-10-20）：
 *   会话列表  GET  api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions
 *   会话消息  GET  api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs
 *
 * ⚠️ 两个接口都要 GET。POST 会返回 "Method Not Allowed" 纯文本。
 */

import fs from "node:fs";
import path from "node:path";
import * as auth from "./auth.js";

const STATE = "imbox-state.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, STATE), "utf8")); }
  catch { return { lastPollAt: null, seen: {} }; }
}

function writeState(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, STATE), JSON.stringify(st, null, 2) + "\n");
  } catch { /* 忽略 */ }
}

function headers(cred) {
  return { ...auth.headers(cred), "user-agent": UA, referer: "https://message.bilibili.com/" };
}

/** 从 content 里抠出正文（私信 content 是 JSON 字符串） */
function textOf(m) {
  const raw = String(m?.content ?? "");
  try {
    const c = JSON.parse(raw);
    return String(c.content ?? c.text ?? c.title ?? "").trim();
  } catch {
    return raw.trim();
  }
}

/**
 * 拉会话列表。
 * @returns {Promise<{ok:boolean, sessions:Array, error?:string}>}
 */
export async function sessions(sdk, dataDir, { cred } = {}) {
  const c = cred || auth.loadCredentials(dataDir);
  if (!c) return { ok: false, sessions: [], error: "没有凭据" };

  // 需要自己的 mid 来区分「谁说的」
  let myMid = "";
  try {
    const nav = await sdk.network.fetch("https://api.bilibili.com/x/web-interface/nav", { method: "GET", headers: auth.headers(c) });
    const nj = typeof nav.json === "function" ? await nav.json() : JSON.parse(String(nav));
    myMid = String(nj?.data?.mid ?? "");
  } catch { /* 拿不到就算了 */ }

  try {
    const r = await sdk.network.fetch(
      "https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions" +
      "?session_type=1&group_fold=1&unfold_fold=0&sort_rule=2&build=0&mobi_app=web",
      { method: "GET", headers: headers(c) },
    );
    const txt = await (typeof r.text === "function" ? r.text() : Promise.resolve(String(r)));
    let j;
    try { j = JSON.parse(txt); } catch {
      return { ok: false, sessions: [], error: `非 JSON 响应：${txt.slice(0, 80)}` };
    }
    if (j?.code !== 0) return { ok: false, sessions: [], error: `code=${j?.code} ${j?.message || ""}` };

    const list = j?.data?.session_list || [];
    const out = list.map((s) => ({
      mid: String(s.talker_id ?? ""),
      unread: Number(s.unread_count ?? 0),
      // 系统通知（账号登录提示等）也混在里面，标记出来
      system: String(s.talker_id ?? "").length > 12 && !/^\d{1,10}$/.test(String(s.talker_id ?? "")),
      lastText: textOf(s.last_msg || {}),
      lastAt: Number(s.session_ts ?? s.last_msg?.timestamp ?? 0),
      name: s.account_info?.name || s.talker_name || "",
      myMid,
    })).filter((x) => x.mid);

    writeState(dataDir, { ...readState(dataDir), lastPollAt: new Date().toISOString() });
    return { ok: true, sessions: out, myMid };
  } catch (e) {
    return { ok: false, sessions: [], error: String(e && e.message ? e.message : e).slice(0, 150) };
  }
}

/**
 * 拉某个会话的消息。
 * @returns {Promise<{ok:boolean, messages:Array, myMid:string, error?:string}>}
 */
export async function messages(sdk, dataDir, { mid, size = 20, cred } = {}) {
  const c = cred || auth.loadCredentials(dataDir);
  if (!c) return { ok: false, messages: [], error: "没有凭据" };
  const talker = String(mid || "");
  if (!talker) return { ok: false, messages: [], error: "缺 mid" };

  let myMid = "";
  try {
    const nav = await sdk.network.fetch("https://api.bilibili.com/x/web-interface/nav", { method: "GET", headers: auth.headers(c) });
    const nj = typeof nav.json === "function" ? await nav.json() : JSON.parse(String(nav));
    myMid = String(nj?.data?.mid ?? "");
  } catch { /* 忽略 */ }

  try {
    const r = await sdk.network.fetch(
      `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs` +
      `?talker_id=${talker}&session_type=1&size=${Number(size) > 0 ? Number(size) : 20}&build=0&mobi_app=web`,
      { method: "GET", headers: headers(c) },
    );
    const txt = await (typeof r.text === "function" ? r.text() : Promise.resolve(String(r)));
    let j;
    try { j = JSON.parse(txt); } catch {
      return { ok: false, messages: [], error: `非 JSON 响应：${txt.slice(0, 80)}` };
    }
    if (j?.code !== 0) return { ok: false, messages: [], error: `code=${j?.code} ${j?.message || ""}` };

    const msgs = (j?.data?.messages || []).map((m) => ({
      // 私信的 id 字段叫 msg_key
      id: String(m.msg_key ?? m.id ?? ""),
      at: Number(m.timestamp ?? 0),
      atText: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : "",
      fromMe: String(m.sender_uid) === myMid,
      fromMid: String(m.sender_uid ?? ""),
      text: textOf(m),
      type: Number(m.msg_type ?? 1),
    })).filter((x) => x.text);

    // ⚠ B站 返回的是**新→旧**（最新的在前）。
    // 之前写了 .reverse()，结果旧→新，但调用方都当「最后一条=最新」用 → 逻辑全反。
    // 现在统一成**旧→新**（时间顺序），末尾就是最新的。
    msgs.sort((a, b) => a.at - b.at);

    return { ok: true, messages: msgs, myMid };
  } catch (e) {
    return { ok: false, messages: [], error: String(e && e.message ? e.message : e).slice(0, 150) };
  }
}

/**
 * 拉所有会话里「对方最后说的话」，只返回**没回过的**那些。
 *
 * 这就是她的「私信收件箱」：有人对她说话，她还没接。
 */
export async function unreplied(sdk, dataDir, { cred, onlyNew = false } = {}) {
  const s = await sessions(sdk, dataDir, { cred });
  if (!s.ok) return { ok: false, items: [], error: s.error };

  const st = readState(dataDir);
  const seen = st.seen || {};

  const items = [];
  for (const sess of s.sessions) {
    if (sess.system) continue;              // 系统通知不算「有人找她」
    if (!sess.unread && !sess.lastText) continue;

    const m = await messages(sdk, dataDir, { mid: sess.mid, size: 10, cred });
    if (!m.ok || !m.messages.length) continue;

    const last = m.messages[m.messages.length - 1];
    // 最后一条是对方说的 → 等她回
    if (!last.fromMe) {
      // 2026-10-21 修：之前不看去重，同一条私信每次都算「新的」。
      // 结果 inbox.tick 每 10 分钟把它当新消息，连叫醒五次，每次都白跑一轮模型。
      // 现在：onlyNew=true 时，已经见过的不再重复报。
      if (onlyNew && last.id && seen[last.id]) continue;

      items.push({
        source: "dm",
        mid: sess.mid,
        name: sess.name || `uid ${sess.mid}`,
        id: last.id,
        at: last.at,
        atText: last.atText,
        text: last.text,
        unread: sess.unread,
        // 最近几条上下文（让她知道在聊什么）
        context: m.messages.slice(-5).map((x) => ({
          fromMe: x.fromMe, text: x.text,
        })),
      });
    }
  }

  items.sort((a, b) => a.at - b.at);
  return { ok: true, items };
}

/**
 * 把一批私信标记为已见（推进水位）。
 *
 * 为什么需要这个：`unreplied` 每次都会把「最后一条不是她发的」全返回，
 * 不推进水位就会无限重复抱同一条。
 */
export function markSeen(dataDir, ids = []) {
  const st = readState(dataDir);
  const seen = { ...(st.seen || {}) };
  for (const id of ids) {
    if (id) seen[String(id)] = Date.now();
  }
  // 只留最近 500 条，避免无限涨
  const keys = Object.keys(seen);
  if (keys.length > 500) {
    keys.sort((a, b) => Number(seen[a]) - Number(seen[b]))
      .slice(0, keys.length - 500)
      .forEach((k) => { delete seen[k]; });
  }
  writeState(dataDir, { ...st, seen, lastPollAt: new Date().toISOString() });
  return { ok: true, marked: ids.length };
}

export function status(dataDir) {
  const st = readState(dataDir);
  return { lastPollAt: st.lastPollAt || null, seenCount: Object.keys(st.seen || {}).length };
}
