/**
 * lib/linkqueue.js — 他发来的视频，排一队等着她看（2026-10-23）
 *
 * 由来：他私信里丢两个 BV 链接过来，她回了话——但那条视频她一次都没打开。
 * 因为 social 回合的工具表里只有 inbox / reply，content 回合又只看推荐流。
 * 两条路没有交集：「他发给你看」这件事在代码里根本不存在。
 * 收下了却从没看，不叫陪看。
 *
 * 规则：
 *   · 只收**主人**发来的链接（别人的转发不是吩咐）。谁算主人由 ownerMid 定。
 *   · 同一个 BV 只排一次；真看过（debrief 成功）才标掉，不是「回完话就算看过」。
 *   · 30 天没看的自动清掉——陈年链接不该在她快忘了这事的时候突然冒出来。
 *   · 只影响「看什么」，**不授予任何写权限**：点赞 / 评论 / 分享仍然各走各的闸门。
 */

import fs from "node:fs";
import path from "node:path";

const FILE = "watch-queue.json";
const MAX_ITEMS = 30;
const KEEP_DAYS = 30;

// BV 号固定是 BV + 10 位
const BV_RE = /BV[0-9A-Za-z]{10}/g;
const SHORT_RE = /https?:\/\/b23\.tv\/([0-9A-Za-z]+)/g;

/**
 * 标题归一：去掉标点、空白、链接，以及尾部的「-哔哩哔哩」。
 * 用于「按标题找视频」时判断搜索结果是不是同一条。
 */
export function normTitle(s) {
  return String(s || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[【】《》\[\]（）()「」『』\s\-—_|｜:：,，.。!！?？~～、]/g, "")
    .replace(/(哔哩哔哩|bilibili).*$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * 像不像「一条视频的标题」。
 *
 * 只在消息里既没有 BV、也没有 b23 短链时才用得上；宁可漏，不要误——
 * 把一句闲聊（"看完了吗"）当成标题去搜索，既浪费请求，也可能认错片。
 */
export function looksLikeTitle(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (t.length < 6) return false;
  if (bvOf(t)) return false;
  // 带书名号/方括号的多半是分享卡片，就算带问号也算标题；
  // 没括号又以问句收尾的，基本是在跟她说话。
  const hasBracket = /[【《]/.test(t);
  if (!hasBracket && (/[?？]$/.test(t) || /(吗|呢|吧)$/.test(t))) return false;
  return hasBracket || t.length >= 8;
}

const nowIso = () => new Date().toISOString();
const day = 24 * 60 * 60 * 1000;

/**
 * 从一段文字里抠出视频引用。纯函数（不联网、不读盘），方便测。
 * @returns {{bvs:string[], shorts:string[]}}
 */
export function extract(text) {
  const s = String(text || "");
  const bvs = [...new Set(s.match(BV_RE) || [])];
  const shorts = [...new Set((s.match(SHORT_RE) || []).map((u) => u.trim()))];
  return { bvs, shorts };
}

/** 从 任意 URL / 文本 里取 BV（b23 短链取不到，返回空串） */
export function bvOf(text) {
  const m = String(text || "").match(BV_RE);
  return m ? m[0] : "";
}

/**
 * 从一条消息里取正文。
 *
 * ⚠️ 这里的坑（2026-10-23，复核拓出来的）：私信的条目是 `{ body }`，
 * 而 `msgfeed.poll()` 的条目是 `{ source, title }`——没有 body、没有 text。
 * 只读 `body || text` 的话，**评论 / @ 里的链接永远抽不到**，
 * 而 DECISIONS 里写的是「私信/评论」。两处字段名不一样，只能在这里抹平。
 */
export function textOfMessage(m) {
  return String(m?.body || m?.text || m?.source || m?.title || "").trim();
}

const TITLES = "title-candidates.json";

function readTitles(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, TITLES), "utf8"));
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

function writeTitles(dataDir, items) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, TITLES), JSON.stringify({ items: items.slice(-5) }, null, 2) + "\n");
  } catch { /* 忽略 */ }
}

/** 记下「他可能发了个标题，但没找到唯一匹配」的候选，等她回话时问一句。 */
export function rememberTitleCandidates(dataDir, { key = "", text = "", from = "", mid = "", candidates = [] } = {}) {
  try {
    const list = readTitles(dataDir);
    const item = {
      key, text: String(text).slice(0, 120), from, mid,
      at: nowIso(), candidates: (candidates || []).slice(0, 3),
    };
    const hit = list.find((x) => x.key === key);
    if (hit) Object.assign(hit, item); else list.push(item);
    writeTitles(dataDir, list);
    return { ok: true, item };
  } catch { return { ok: false }; }
}

export function titleCandidates(dataDir) {
  return readTitles(dataDir);
}

export function clearTitleCandidates(dataDir, key = "") {
  try {
    writeTitles(dataDir, readTitles(dataDir).filter((x) => x.key !== key));
    return { ok: true };
  } catch { return { ok: false }; }
}

function emptyState() {
  return { updatedAt: nowIso(), items: [] };
}

function prune(items) {
  const now = Date.now();
  return (Array.isArray(items) ? items : []).filter((it) => {
    if (!it || typeof it !== "object") return false;
    const at = Date.parse(it.at || "");
    if (!Number.isFinite(at)) return false;
    // 看过的留 7 天（够「最近看过」查询），没看的留 30 天
    const keep = it.watchedAt ? 7 * day : KEEP_DAYS * day;
    return now - at <= keep;
  });
}

function read(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8"));
    const items = prune(j && j.items);
    return { updatedAt: (j && j.updatedAt) || nowIso(), items };
  } catch {
    return emptyState();
  }
}

function write(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const next = { updatedAt: nowIso(), items: prune(st.items).slice(-MAX_ITEMS) };
    fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify(next, null, 2) + "\n");
    return next;
  } catch {
    return st;
  }
}

/**
 * 排进队里。已看过的不再排（他重复发同一条不代表要重看一遍）。
 * @returns {{added:boolean, item?:object, reason?:string}}
 */
export function enqueue(dataDir, { bv = "", short = "", from = "", mid = "", source = "dm", note = "", title = "", at = "" } = {}) {
  const key = String(bv || short || "").trim();
  if (!key) return { added: false, reason: "没有 BV 或短链" };

  const st = read(dataDir);
  const hit = st.items.find((it) => (bv && it.bv === bv) || (short && it.short === short));
  if (hit) {
    if (hit.watchedAt) return { added: false, reason: "这条她已经看过", item: hit };
    // 又在说同一条：把「他说的话」更新成最新那句
    if (note) hit.note = String(note).slice(0, 200);
    hit.lastAt = at || nowIso();
    write(dataDir, st);
    return { added: false, reason: "已经在队里", item: hit };
  }

  const item = {
    bv: bv || "",
    short: short || "",
    url: bv ? `https://www.bilibili.com/video/${bv}` : (short || ""),
    title: String(title || ""),
    note: String(note || "").slice(0, 200),
    from: String(from || ""),
    mid: String(mid || ""),
    source: String(source || "dm"),
    at: at || nowIso(),
  };
  st.items.push(item);
  write(dataDir, st);
  return { added: true, item };
}

/** 还没看的，最旧的先看 */
export function pending(dataDir, limit = 5) {
  const st = read(dataDir);
  return st.items.filter((it) => !it.watchedAt).slice(0, Math.max(1, Number(limit) || 5));
}

/** 最近看过的（按 watchedAt 倒序），默认 2 条。用于「主人重提已看视频」时回话引用。 */
export function recentlyWatched(dataDir, limit = 2) {
  const st = read(dataDir);
  return st.items
    .filter((it) => it.watchedAt)
    .sort((a, b) => String(b.watchedAt).localeCompare(String(a.watchedAt)))
    .slice(0, Math.max(1, Number(limit) || 2));
}

/** 标成看过。只有真的 debrief 成功才调这里。 */
export function markWatched(dataDir, bv) {
  const key = bvOf(bv) || String(bv || "").trim();
  if (!key) return { ok: false, reason: "没有 BV" };
  const st = read(dataDir);
  const hit = st.items.find((it) => it.bv === key || it.short === key);
  if (!hit) return { ok: false, reason: "不在队里" };
  hit.watchedAt = nowIso();
  write(dataDir, st);
  return { ok: true, item: hit };
}

export function status(dataDir) {
  const st = read(dataDir);
  return {
    total: st.items.length,
    pending: st.items.filter((it) => !it.watchedAt).length,
    watched: st.items.filter((it) => it.watchedAt).length,
    items: st.items.slice(-MAX_ITEMS),
  };
}

/**
 * 把一批消息里主人发的视频链接排进队。
 *
 * 单独抽出来（而不是塞在 inbox handler 里）是为了能测：
 * 私信和评论/@ 的正文在不同字段上，两路都得走通才算完。
 *
 * @param {object[]} messages  私信或 msgfeed 的条目（字段不一样，textOfMessage 会抹平）
 * @param {{ownerMid?:string, resolveShort?:(url:string)=>Promise<string>}} opts
 *        resolveShort：b23 短链展开器，拿不到就保留原链（prompt 里会明说没展开）
 * @returns {Promise<{queued:number}>}
 */
export async function collectFromMessages(dataDir, messages, { ownerMid = "", resolveShort = null, resolveTitle = null } = {}) {
  let queued = 0;
  const owner = String(ownerMid || "");

  for (const m of Array.isArray(messages) ? messages : []) {
    if (owner && String(m?.mid || "") !== owner) continue;   // 别人的转发不是吩咐
    const text = textOfMessage(m);
    if (!text) continue;

    const who = m.who || "主人";
    const mid = m.mid;
    const source = m.kind === "dm" ? "dm" : "comment";
    const { bvs, shorts } = extract(text);

    for (const bv of bvs) {
      if (enqueue(dataDir, { bv, from: who, mid, source, note: text }).added) queued += 1;
    }
    for (const short of shorts) {
      let resolved = "";
      if (typeof resolveShort === "function") {
        try { resolved = bvOf(await resolveShort(short)) || ""; } catch { /* 展不开就保留原链 */ }
      }
      const item = resolved
        ? enqueue(dataDir, { bv: resolved, from: who, mid, source, note: text })
        : enqueue(dataDir, { short, from: who, mid, source, note: text });
      if (item.added) queued += 1;
    }

    // 既没有 BV 也没有短链：可能是「只发了标题」（分享卡片被截断也是这个样子）
    if (!bvs.length && !shorts.length && typeof resolveTitle === "function" && looksLikeTitle(text)) {
      let r = null;
      try { r = await resolveTitle(text); } catch { r = null; }
      if (r && r.bvid) {
        const item = enqueue(dataDir, { bv: r.bvid, from: who, mid, source, note: text, title: r.title || "" });
        if (item.added) queued += 1;
      } else if (r && Array.isArray(r.candidates) && r.candidates.length) {
        rememberTitleCandidates(dataDir, {
          key: String(text).slice(0, 80), text, from: who, mid, candidates: r.candidates,
        });
      }
    }
  }

  return { queued };
}
