/**
 * lib/self.js — 自我认识层（P1，2026-10-22）
 *
 * 问题：她会写笔记、写两本日记，但 brain 的工具里没有一个「读」。
 * 每轮醒来的她，人格连续、记忆断片。这里给她一个 App 内自有的、可累积、
 * 可修正、可撤回的「自我认识」层。
 *
 * 设计（对齐 DSH dsh-bili-humanism 的 human-world.md）：
 *   · 每天至多选一句「我的认识」（非摘要），带来源 + 修订号
 *   · 只影响理解，**永不授予权限**（revisable_record_not_permission）
 *   · 接地校验：句子必须字面出现在来源笔记的 title/summary 里
 *
 * 数据：
 *   self.json —— 账本（唯一真相，代码读）
 *   self.md   —— 渲染（人随时能打开看）
 */
import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";

const LEDGER = "self.json";
const RENDER = "self.md";
const MAX_SENTENCE = 200;
const MAX_RECENT = 7;

function ledgerPath(dataDir) { return path.join(dataDir, LEDGER); }
function renderPath(dataDir) { return path.join(dataDir, RENDER); }

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function readLedger(dataDir) {
  const p = ledgerPath(dataDir);
  // 文件不存在 = 全新安装，是空账本不是损坏
  if (!fs.existsSync(p)) return { entries: [], corrupt: false };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { entries: Array.isArray(j?.entries) ? j.entries : [], corrupt: false };
  } catch {
    return { entries: [], corrupt: true };
  }
}

function writeLedger(dataDir, entries) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ledgerPath(dataDir), JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2) + "\n");
}

/** 账本 → self.md 渲染（给人打开看） */
export function render(dataDir, entries) {
  const lines = [
    "# 自我认识",
    "",
    "> 这是陪看自己的认识，会随经历修改。它影响我怎么理解，不给我任何权限。",
    "> role: revisable_record_not_permission",
    "",
  ];
  for (const e of [...entries].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const status = e.status === "retracted" ? "（已撤回）" : "";
    lines.push(`## ${e.date}${status}`);
    lines.push("");
    lines.push(`> ${e.sentence}`);
    lines.push("");
    const src = [];
    if (e.source?.noteId) src.push(`笔记 ${e.source.noteId}`);
    if (e.source?.bvid) src.push(`BV ${e.source.bvid}`);
    src.push(`修订 ${e.revision}`);
    lines.push(`来源手账：${src.join(" · ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function writeRender(dataDir, entries) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(renderPath(dataDir), render(dataDir, entries));
}

/** 读全部（active + retracted） */
export function read(dataDir) {
  return readLedger(dataDir).entries;
}

/** 最近的 active 条目（按 date 降序） */
export function recent(dataDir, n = MAX_RECENT) {
  return read(dataDir)
    .filter((e) => e.status === "active")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, n);
}

/** 渲染成给 systemPrompt 的段；空 → 空串（不产生空段） */
export function brief(dataDir, n = MAX_RECENT) {
  const rows = recent(dataDir, n);
  if (!rows.length) return "";
  const lines = ["=== 你最近的认识（会随经历变，只影响你怎么看，不给你任何权限） ==="];
  for (const r of rows) {
    lines.push(`· ${r.date}：${r.sentence}`);
  }
  return lines.join("\n");
}

/**
 * 选一句「我的认识」。
 * 接地该校验：sentence 必须字面出现在来源笔记的 title 或 summary 里。
 * 每天至多一条；同日重复 → already_selected；跨天重复同句 → already_known。
 */
export function select(dataDir, { noteId, sentence }) {
  const s = String(sentence || "").trim();
  if (!s) return { ok: false, reason: "认识的句子是空的" };
  if (s.length > MAX_SENTENCE) return { ok: false, reason: `句子太长（${s.length} > ${MAX_SENTENCE}）` };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, reason: "句子含控制字符" };

  // 找来源笔记（必须真实存在）
  const note = store.listNotes(dataDir, 500).find((n) => String(n.id || "") === String(noteId || ""));
  if (!note) return { ok: false, reason: `找不到来源笔记 ${noteId}` };

  // 接地校验：字面包含
  const hay = `${String(note.title || "")} ${String(note.summary || "")}`;
  if (!hay.includes(s)) return { ok: false, reason: "这句话不在笔记里（接地校验失败）" };

  // 账本
  const ledger = readLedger(dataDir);
  if (ledger.corrupt) return { ok: false, reason: "self 账本损坏，拒绝写入（不覆盖）" };

  const date = today();
  const existing = ledger.entries.find((e) => e.date === date && e.status === "active");
  if (existing) return { ok: false, reason: "already_selected", already: true, date };

  const dup = ledger.entries.find((e) => e.sentence === s);
  if (dup) return { ok: false, reason: "already_known", alreadyKnown: true, date: dup.date };

  const entry = {
    id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    date,
    sentence: s,
    source: {
      noteId: String(note.id || ""),
      bvid: String(note.bvid || "") || undefined,
      title: String(note.title || "").slice(0, 80) || undefined,
    },
    revision: 1,
    status: "active",
    createdAt: new Date().toISOString(),
    history: [{ revision: 1, sentence: s, at: new Date().toISOString() }],
  };
  ledger.entries.push(entry);
  writeLedger(dataDir, ledger.entries);
  writeRender(dataDir, ledger.entries);
  return { ok: true, entry };
}

/** 修订当天那条（留旧版进 history） */
export function revise(dataDir, { date, noteId, sentence }) {
  const s = String(sentence || "").trim();
  if (!s) return { ok: false, reason: "句子是空的" };
  if (s.length > MAX_SENTENCE) return { ok: false, reason: "句子太长" };

  const note = store.listNotes(dataDir, 500).find((n) => String(n.id || "") === String(noteId || ""));
  if (!note) return { ok: false, reason: `找不到来源笔记 ${noteId}` };
  const hay = `${String(note.title || "")} ${String(note.summary || "")}`;
  if (!hay.includes(s)) return { ok: false, reason: "这句话不在笔记里（接地校验失败）" };

  const ledger = readLedger(dataDir);
  const idx = ledger.entries.findIndex((e) => e.date === date && e.status === "active");
  if (idx < 0) return { ok: false, reason: `当天（${date}）没有可修订的条目` };

  const old = ledger.entries[idx];
  const re = {
    ...old,
    sentence: s,
    revision: old.revision + 1,
    history: [...old.history, { revision: old.revision + 1, sentence: s, at: new Date().toISOString() }],
  };
  ledger.entries[idx] = re;
  writeLedger(dataDir, ledger.entries);
  writeRender(dataDir, ledger.entries);
  return { ok: true, entry: re };
}

/** 撤回（status→retracted，不真删） */
export function retract(dataDir, date) {
  const ledger = readLedger(dataDir);
  const idx = ledger.entries.findIndex((e) => e.date === date && e.status === "active");
  if (idx < 0) return { ok: false, reason: `当天（${date}）没有可撤回的条目` };
  ledger.entries[idx] = { ...ledger.entries[idx], status: "retracted", retractedAt: new Date().toISOString() };
  writeLedger(dataDir, ledger.entries);
  writeRender(dataDir, ledger.entries);
  return { ok: true, date };
}

/** 从账本重渲染 self.md（账本损坏时用于恢复展示） */
export function rebuild(dataDir) {
  const ledger = readLedger(dataDir);
  writeRender(dataDir, ledger.entries);
  return { ok: true, path: renderPath(dataDir), entries: ledger.entries.length };
}

export { renderPath, ledgerPath };