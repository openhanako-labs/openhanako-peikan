/**
 * verify/note-fields-check.mjs — 笔记带封面/时长/发布时间
 *
 * 背景（2026-10-20）：截图里笔记只有「写笔记的时刻」，
 * 没有封面、没有时长、没有视频发布时间。
 * 根因：addNote 根本不存这几个字段，bili_note 也不收。
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

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "notefields-"));

console.log("[1] addNote 存新字段");
await ta("cover / duration / pubdate / up / bvid 都存下来", async () => {
  const d = mkDir();
  // 2026-10-20 改：cover 字段只有文件真的在才给
  fs.mkdirSync(path.join(d, "covers"), { recursive: true });
  fs.writeFileSync(path.join(d, "covers", "BV1xx411c7mD-cover.jpg"), "x");

  const n = store.addNote(d, {
    source: "BV1xx411c7mD",
    kind: "video",
    title: "标题",
    summary: "判断",
    marks: ["a"],
    cover: "BV1xx411c7mD-cover.jpg",
    duration: 754,
    pubdate: 1729000000,
    up: "某个UP",
    bvid: "BV1xx411c7mD",
  });
  assert.equal(n.cover, "BV1xx411c7mD-cover.jpg");
  assert.equal(n.duration, 754);
  assert.equal(n.pubdate, 1729000000);
  assert.equal(n.up, "某个UP");
  assert.equal(n.bvid, "BV1xx411c7mD");

  // 回读
  const list = store.listNotes(d, 10);
  assert.equal(list[0].duration, 754);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("不传时给安全默认值（不写 undefined）", async () => {
  const d = mkDir();
  const n = store.addNote(d, { title: "t", summary: "s" });
  assert.equal(n.cover, "");
  assert.equal(n.duration, 0);
  assert.equal(n.pubdate, 0);
  assert.equal(n.up, "");
  assert.equal(n.bvid, "");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("duration 传字符串也能转成数字", async () => {
  const d = mkDir();
  const n = store.addNote(d, { title: "t", summary: "s", duration: "120" });
  assert.equal(n.duration, 120);
  assert.equal(typeof n.duration, "number");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 接口契约");
t("bili_note 声明了新参数", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  const i = src.indexOf('name: "bili_note"');
  const block = src.slice(i, i + 1600);
  for (const k of ["cover", "duration", "pubdate", "up", "bvid"]) {
    assert.ok(block.includes(k), `bili_note 缺参数 ${k}`);
  }
});
t("bili_note 把新参数透传给 addNote", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  const i = src.indexOf('name: "bili_note"');
  const block = src.slice(i, i + 2200);
  assert.ok(block.includes("cover: a.cover"), "没传 cover");
  assert.ok(block.includes("duration: a.duration"), "没传 duration");
});
t("bili_debrief 返回 noteHints", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  assert.ok(src.includes("noteHints"), "debrief 没告诉模型该传什么");
  const i = src.indexOf("noteHints");
  const block = src.slice(i, i + 400);
  assert.ok(block.includes("cover"), "noteHints 里没 cover");
  assert.ok(block.includes("duration"), "noteHints 里没 duration");
});

console.log("\n[3] 前端渲染");
t("封面 URL 用纯 BV 号（/frame 要的就是它）", () => {
  const src = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  // 设计（2026-10-20 修）：/frame?kind=cover&bvid= 只认纯 BV 号，
  // 后端自己拼 .jpg。之前把文件名塞进去 → 双 .jpg → 404。
  assert.ok(src.includes("data-cover="), "没有封面节点");
  assert.ok(src.includes("n.bvid"), "没优先用 n.bvid");
  assert.ok(src.includes("/frame?kind=cover&bvid="), "URL 形式不对");
});
t("显示时长", () => {
  const src = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  assert.ok(src.includes("n.duration > 0"), "没渲染时长");
  assert.ok(src.includes("分 "), "没格式化分钟");
});
t("显示发布时间", () => {
  const src = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  assert.ok(src.includes("n.pubdate > 0"), "没渲染发布时间");
  assert.ok(src.includes("发布"), "没有「发布」字样");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
