/**
 * verify/note-title-check.mjs — 笔记「标题 + 判断」两层的验证
 *
 * 背景（2026-10-20）：之前 summary 一段包打天下，UI 当标题渲染，
 * 于是她的长判断被剪成一句缩略。现在分开存。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const store = await import(pathToFileURL(path.join(APP, "lib/store.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "note-"));

console.log("[1] 存储层：title 独立成字段");
await ta("title + summary 都落盘", async () => {
  const d = mkDir();
  const n = store.addNote(d, {
    title: "热评比正片更能说明问题",
    summary: "一整排人在替杀人者论证解脱，逻辑成立，情感上是在减刑。",
    source: "BV1xx",
  });
  assert.equal(n.title, "热评比正片更能说明问题");
  assert.ok(n.summary.includes("减刑"));

  const read = store.listNotes(d, 10)[0];
  assert.equal(read.title, "热评比正片更能说明问题");
  assert.ok(read.summary.includes("减刑"));
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("不传 title 时是空串，不是 undefined", async () => {
  const d = mkDir();
  const n = store.addNote(d, { summary: "只有判断" });
  assert.equal(n.title, "");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("title 两侧空白被清掉", async () => {
  const d = mkDir();
  const n = store.addNote(d, { title: "  有空格  ", summary: "x" });
  assert.equal(n.title, "有空格");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 旧数据兼容");
await ta("旧笔记没有 title 字段，读到 undefined 不炸", async () => {
  const d = mkDir();
  const p = path.join(d, "notes");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "index.json"), JSON.stringify([
    { id: "n_old", at: new Date().toISOString(), source: "BV_old", summary: "旧格式的一句话" },
  ]));
  const list = store.listNotes(d, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, undefined, "旧数据本来就没有 title");
  assert.equal(list[0].summary, "旧格式的一句话");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 工具声明：title 是必填");
await ta("bili_note 要求 title", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  const i = src.indexOf('name: "bili_note"');
  const block = src.slice(i, i + 1400);
  assert.ok(block.includes("title:"), "工具声明里没有 title 参数");
  assert.ok(/required:\s*\[[^\]]*"title"/.test(block), "title 应该在 required 里");
});
await ta("wake.js 的 TOOLS 也要求 title", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('name: "bili_note"');
  const block = src.slice(i, i + 1200);
  assert.ok(block.includes("title:"), "wake 的工具声明里没有 title");
  assert.ok(/required:\s*\[[^\]]*"title"/.test(block), "title 应该在 required 里");
});
await ta("wake 的 runTool 会把 title 传进 store", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  assert.ok(src.includes("title: String(args.title"), "runTool 没把 title 传下去");
});

console.log("\n[4] UI 渲染：两层分开");
await ta("parseNote 优先用 note.title", () => {
  const js = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  assert.ok(js.includes("n.title.trim()"), "没读 n.title");
  assert.ok(js.includes("isNew"), "没区分新旧结构");
});
await ta("新结构把整段 summary 当判断显示", () => {
  const js = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  assert.ok(js.includes("p.summaryText"), "没渲染 summaryText");
});

console.log("\n[5] 日记摘要优先用 title");
// 2026-10-20 改：日记不再由代码拼（她自己在循环里调 bili_diary 写），
// 所以「日记摘要优先用 title」这条不适用了。
// 改成验证分享的标题行优先用 title —— 那里仍然需要它。
await ta("分享标题行优先用 title", () => {
  const src = fs.readFileSync(path.join(APP, "lib/share.js"), "utf8");
  const i = src.indexOf("export function headlineOf");
  assert.ok(i > 0, "找不到 headlineOf");
  const block = src.slice(i, i + 400);
  assert.ok(block.includes("note?.title"), "headlineOf 没优先用 title");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
