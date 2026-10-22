/**
 * lib/store.js — 本地数据。（P0）
 *
 * 承载：观察笔记 / 草稿箱 / 人审队列 / 两本日记 / 审计流。
 * 全部落在 <dataDir>/，普通文件，人随时能打开看。
 */

import fs from "node:fs";
import path from "node:path";

function dir(dataDir, sub) {
  const p = path.join(dataDir, sub);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}

// ── 观察笔记（她的笔记本）──────────────────────────────────────────────
/**
 * 写一条观察笔记。
 *
 * title / summary 分工（2026-10-20 明确）：
 *   title   —— 一句话标题，可扫、可列、能当书名号的引子（≤ 24 字为宜）
 *   summary —— 她自己的判断，可以长，带推断与棱角
 *
 * 旧数据只有 summary，所以读到缺 title 时由调用方回退（不强行改写历史）。
 */
export /** 笔记软护栏上限：超过后裁剪最旧，保持 index.json 有界 */
const MAX_NOTES = 2000;

export function addNote(dataDir, {
  source = "", kind = "", title = "", summary = "", marks = [],
  cover = "", duration = 0, pubdate = 0, up = "", bvid = "", pic = "",
} = {}) {
  const p = path.join(dir(dataDir, "notes"), "index.json");
  let list = readJson(p, []);

  // 统一从 source 里抽 BV —— 规则路径写的 source 是 "BV:BVxxx"，
  // 之前只在 bili_note 工具里补，而规则路径直接调本函数，绕过了补全。
  // 现在不管谁调，这里一定是唯一出口。
  const bvMatch = String(bvid || source || "").match(/BV[0-9A-Za-z]+/);
  const bv = bvid || (bvMatch ? bvMatch[0] : "");

  // 从视频元数据缓存里补（不再依赖调用方传）
  let meta = null;
  if (bv) {
    try { meta = readJson(path.join(dataDir, "video-meta.json"), {})[bv] || null; } catch { meta = null; }
  }

  // pic（封面地址）也写进缓存：frames.cover 拿到它就不用再请求 view 接口。
  // 2026-10-21：以前不存 pic，导致封面下载每次多一次请求，而那次在 App 沙箱里容易失败。
  if (bv && pic && (!meta || !meta.pic)) {
    try {
      const mp = path.join(dataDir, "video-meta.json");
      const all = readJson(mp, {});
      all[bv] = { ...(all[bv] || { bvid: bv }), pic: String(pic) };
      writeJson(mp, all);
    } catch { /* 缓存失败不影响写笔记 */ }
  }

  const item = {
    // 2026-10-22：同毫秒写两条会撞 id（Date.now() 分辨率不够）。加随机后缀。
    id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    source, kind,
    title: String(title || "").trim(),
    summary,
    marks,
    // 下面这几个是「这条视频本身」的信息。
    // cover 存文件名（covers 下的 xxx.jpg），前端 /frame?bvid= 自己拼。
    //
    // 只有文件真的在磁盘上才写 cover 字段 —— 否则界面会拿一个不存在的路径去请求，
    // 收到 404 后靠前端隐藏整块。那看起来就像「有的有封面有的没有」。
    cover: (() => {
      const name = String(cover || (meta && meta.cover) || (bv ? `${bv}.jpg` : ""));
      if (!name) return "";
      try {
        return fs.existsSync(path.join(dataDir, "covers", name)) ? name : "";
      } catch { return ""; }
    })(),
    duration: Number(duration) || Number(meta && meta.duration) || 0,
    pubdate: Number(pubdate) || Number(meta && meta.pubdate) || 0,
    up: String(up || (meta && meta.up) || ""),
    bvid: bv,
  };
  list.push(item);
  // 2026-10-22（P2-3）：超过软护栏就裁剪最旧，索引保持有界。
  if (list.length > MAX_NOTES) list = list.slice(-MAX_NOTES);
  writeJson(p, list);
  return item;
}

export function listNotes(dataDir, limit = 100) {
  const p = path.join(dir(dataDir, "notes"), "index.json");
  const list = readJson(p, []);
  return list.slice(-limit).reverse();
}

// ── 草稿箱 ─────────────────────────────────────────────────────────────
export function addDraft(dataDir, { text = "", kind = "comment", targetBv = "", via = "comment" } = {}) {
  const p = path.join(dir(dataDir, "drafts"), "index.json");
  const list = readJson(p, []);
  const item = { id: `d_${Date.now()}`, at: new Date().toISOString(), text, kind, targetBv, via, status: "draft" };
  list.push(item);
  writeJson(p, list);
  return item;
}

export function listDrafts(dataDir) {
  const p = path.join(dir(dataDir, "drafts"), "index.json");
  return readJson(p, []);
}

export function setDraftStatus(dataDir, id, status) {
  const p = path.join(dir(dataDir, "drafts"), "index.json");
  const list = readJson(p, []);
  const it = list.find((x) => x.id === id);
  if (it) { it.status = status; writeJson(p, list); }
  return it ?? null;
}

// ── 人审队列（HOLD）────────────────────────────────────────────────────
export function pushReview(dataDir, { draftId = "", text = "", reasons = [] } = {}) {
  const p = path.join(dir(dataDir, "review"), "index.json");
  const list = readJson(p, []);
  const item = { id: `r_${Date.now()}`, at: new Date().toISOString(), draftId, text, reasons, status: "pending" };
  list.push(item);
  writeJson(p, list);
  return item;
}

export function listReview(dataDir, status) {
  const p = path.join(dir(dataDir, "review"), "index.json");
  const list = readJson(p, []);
  return status ? list.filter((x) => x.status === status) : list;
}

export function resolveReview(dataDir, id, status) {
  const p = path.join(dir(dataDir, "review"), "index.json");
  const list = readJson(p, []);
  const it = list.find((x) => x.id === id);
  if (it) { it.status = status; it.resolvedAt = new Date().toISOString(); writeJson(p, list); }
  return it ?? null;
}

// ── 两本日记 ───────────────────────────────────────────────────────────
export function appendDiary(dataDir, which, text, title = "") {
  const file = which === "private" ? "diary-private.md" : "diary-executive.md";
  const p = path.join(dataDir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 2026-10-20 改：标题可由她自己定。以前只有时间戳，每节长得一模一样。
  const now = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const head = title ? `${stamp} · ${String(title).trim()}` : stamp;
  fs.appendFileSync(p, `\n## ${head}\n\n${text}\n`);
  return p;
}

/** 读日记，按日期段（## 开头）拆成条目，新的在前 */
export function readDiary(dataDir, which, limit = 50) {
  const file = which === "private" ? "diary-private.md" : "diary-executive.md";
  const p = path.join(dataDir, file);
  let raw = "";
  try { raw = fs.readFileSync(p, "utf8"); } catch { return []; }

  const parts = raw.split(/^## /m).map((s) => s.trim()).filter(Boolean);
  const items = parts.map((chunk) => {
    const nl = chunk.indexOf("\n");
    const head = nl >= 0 ? chunk.slice(0, nl).trim() : chunk.trim();
    const body = nl >= 0 ? chunk.slice(nl + 1).trim() : "";
    // head 可能是两种：
    //   ISO（旧）  "2026-10-20T11:16:07.813Z"
    //   人读（新）  "2026-10-20 19:52 · 标题"
    // 前端解析不了人读格式，所以这里额外给一个可解析的 at，失败就原样。
    let at = head;
    const isoLike = head.match(/^\d{4}-\d{2}-\d{2}T/);
    if (!isoLike) {
      const m = head.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
      if (m) at = `${m[1]}T${String(m[2]).padStart(2, "0")}:${m[3]}:00`;
    }
    // 标题（“ · 标题”里的那部分）
    const titleMatch = head.match(/^\d{4}-\d{2}-\d{2}[T\s][\d:]+(?:\.\d+Z?)?\s*·\s*(.+)$/);
    return { at, head, title: titleMatch ? titleMatch[1].trim() : "", text: body };
  });
  return items.reverse().slice(0, limit);
}

// ── 审计流 ─────────────────────────────────────────────────────────────
export function audit(dataDir, entry) {
  const p = path.join(dataDir, "audit.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function listAudit(dataDir, limit = 200) {
  const p = path.join(dataDir, "audit.jsonl");
  let lines = [];
  try { lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean); } catch { /* empty */ }
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}
