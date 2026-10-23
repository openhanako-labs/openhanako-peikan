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
