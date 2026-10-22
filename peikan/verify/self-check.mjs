/**
 * verify/self-check.mjs — 自我认识层验证（P1，2026-10-22）
 *
 * 覆盖：接地校验 / 当天唯一 / 跨天防重 / 修订留档 / 撤回不真删 / 渲染 /
 *       brief 注入 / 权限红线（not_permission）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const self = await import(pathToFileURL(path.join(APP, "lib/self.js")).href);
const store = await import(pathToFileURL(path.join(APP, "lib/store.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "self-"));

// 造一条真实笔记，返回它的 id
function seedNote(d, { title, summary } = {}) {
  const n = store.addNote(d, {
    title: title ?? "一条线的背面", kind: "video", source: "BV1xx",
    summary: summary ?? "一整排人替一个被杀死的婴儿论证死了是解脱。这是一条线的背面。",
  });
  return n.id;
}

console.log("[1] 接地校验");
t("句子必须来自真实笔记", () => {
  const d = mkDir();
  const r = self.select(d, { noteId: "n_不存在的", sentence: "随便一句" });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).includes("找不到来源笔记"));
  fs.rmSync(d, { recursive: true, force: true });
});
t("不接地（句子不在笔记里）被拒", () => {
  const d = mkDir();
  const id = seedNote(d);
  const r = self.select(d, { noteId: id, sentence: "这是一句新编的话，不在笔记里" });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).includes("接地校验"));
  fs.rmSync(d, { recursive: true, force: true });
});
t("接地（句子在笔记里）通过", () => {
  const d = mkDir();
  const id = seedNote(d);
  const r = self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.entry.sentence, "一整排人替一个被杀死的婴儿论证死了是解脱");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 当天唯一");
t("同日第二次 select → already_selected", () => {
  const d = mkDir();
  const id = seedNote(d);
  const s1 = self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  assert.equal(s1.ok, true);
  const s2 = self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  assert.equal(s2.ok, false);
  assert.equal(s2.already, true);
  fs.rmSync(d, { recursive: true, force: true });
});
t("同日不同句也拒（每天至多一条）", () => {
  const d = mkDir();
  const id = seedNote(d, { summary: "句子甲。句子乙。" });
  const s1 = self.select(d, { noteId: id, sentence: "句子甲" });
  assert.equal(s1.ok, true);
  const s2 = self.select(d, { noteId: id, sentence: "句子乙" });
  assert.equal(s2.ok, false, "同日第二次不管哪句都该拒绝");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 跨天防重");
t("同句跨天 → already_known（需要先清账本日期）", () => {
  const d = mkDir();
  const id = seedNote(d);
  const s1 = self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  assert.equal(s1.ok, true);
  // 手动改账本日期到昨天，模拟跨天
  const ledger = path.join(d, "self.json");
  const j = JSON.parse(fs.readFileSync(ledger, "utf8"));
  j.entries[0].date = "2000-01-01";
  fs.writeFileSync(ledger, JSON.stringify(j));
  const s2 = self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  assert.equal(s2.ok, false);
  assert.equal(s2.alreadyKnown, true, "同句跨天应标记 already_known");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 修订 / 撤回");
t("修改当天条目 → revision+1，旧版进 history", () => {
  const d = mkDir();
  const id = seedNote(d, { summary: "原判断。新判断。" });
  const s1 = self.select(d, { noteId: id, sentence: "原判断" });
  assert.equal(s1.ok, true);
  const date = s1.entry.date;
  const r = self.revise(d, { date, noteId: id, sentence: "新判断" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.entry.revision, 2);
  assert.equal(r.entry.history.length, 2);
  assert.equal(r.entry.history[0].revision, 1);
  assert.equal(r.entry.history[1].revision, 2);
  fs.rmSync(d, { recursive: true, force: true });
});
t("撤回 → recent 不含，账本仍留", () => {
  const d = mkDir();
  const id = seedNote(d);
  const s1 = self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  const date = s1.entry.date;
  const r = self.retract(d, date);
  assert.equal(r.ok, true);
  const recent = self.recent(d, 10);
  assert.equal(recent.length, 0, "撤回后 recent 应为空");
  const all = self.read(d);
  assert.equal(all.length, 1, "账本仍保留（status=retracted）");
  assert.equal(all[0].status, "retracted");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[5] 渲染 / 注入");
t("rebuild 生成 self.md 且与账本一致", () => {
  const d = mkDir();
  const id = seedNote(d);
  const s1 = self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  const r = self.rebuild(d);
  assert.equal(r.ok, true);
  const md = fs.readFileSync(path.join(d, "self.md"), "utf8");
  assert.ok(md.includes("一整排人替一个被杀死的婴儿论证死了是解脱"), "md 应含句子");
  assert.ok(md.includes(s1.entry.source.noteId), "md 应含来源笔记 id");
  fs.rmSync(d, { recursive: true, force: true });
});
t("brief 空时返回空串（不产生空段）", () => {
  const d = mkDir();
  assert.equal(self.brief(d, 7), "");
  fs.rmSync(d, { recursive: true, force: true });
});
t("有人时 brief 含 not_permission 红线 + 句子", () => {
  const d = mkDir();
  const id = seedNote(d);
  self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  const b = self.brief(d, 7);
  assert.ok(b.includes("不给你任何权限") || b.includes("不授予"), "brief 没带权限红线");
  assert.ok(b.includes("一整排人"), "brief 没带句子");
  fs.rmSync(d, { recursive: true, force: true });
});
t("self.md 头部带 not_permission 标记", () => {
  const d = mkDir();
  const id = seedNote(d);
  self.select(d, { noteId: id, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  const md = fs.readFileSync(path.join(d, "self.md"), "utf8");
  assert.ok(md.includes("not_permission") || md.includes("不给我任何权限"), "self.md 没标权限红线");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[6] 账本损坏 → 拒绝写入（fail-closed）");
t("账本坏时 select 拒绝", () => {
  const d = mkDir();
  const id = seedNote(d);
  fs.writeFileSync(path.join(d, "self.json"), "{ 这不是json");
  const r = self.select(d, { noteId: id, sentence: "一整排人" });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).includes("账本损坏"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);