/**
 * verify/video-meta-check.mjs — 视频元数据缓存 + 笔记自动补全
 *
 * 背景（2026-10-20）：让模型「记得复制字段」失败了两次。
 * debrief 返回了 noteHints，她 4 条笔记一次都没传 cover/duration。
 * 改成 App 自己缓存 + 自动补全。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const vm = await import(pathToFileURL(path.join(APP, "lib/video-meta.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vmeta-"));

console.log("[1] BV 号抽取");
t("从裸 BV 里抽", () => assert.equal(vm.bvOf("BV1xx411c7m2"), "BV1xx411c7m2"));
t("从 URL 里抽", () => assert.equal(vm.bvOf("https://www.bilibili.com/video/BV1xx411c7mD?p=1"), "BV1xx411c7mD"));
t("从 BV: 前缀里抽", () => assert.equal(vm.bvOf("BV:BV1v8pZ67Edb"), "BV1v8pZ67Edb"));
t("没有就空串", () => assert.equal(vm.bvOf("随便一个关键词"), ""));
t("空值不炸", () => { assert.equal(vm.bvOf(null), ""); assert.equal(vm.bvOf(undefined), ""); });

console.log("\n[2] 存取");
await ta("存了能取回来", async () => {
  const d = mkDir();
  vm.saveMeta(d, "BV1xx411c7m2", { title: "鲁迅", up: "观视频", duration: 2779, pubdate: 1792234800 });
  const m = vm.getMeta(d, "BV1xx411c7m2");
  assert.equal(m.up, "观视频");
  assert.equal(m.duration, 2779);
  assert.equal(m.cover, "BV1xx411c7m2.jpg");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("没存过返回 null", async () => {
  const d = mkDir();
  assert.equal(vm.getMeta(d, "BVnope"), null);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("重复存会合并，不丢旧字段", async () => {
  const d = mkDir();
  vm.saveMeta(d, "BV1x", { up: "A", duration: 100 });
  vm.saveMeta(d, "BV1x", { title: "新标题" });   // 这次没传 up/duration
  const m = vm.getMeta(d, "BV1x");
  assert.equal(m.title, "新标题");
  assert.equal(m.up, "A", "旧字段不该被清掉");
  assert.equal(m.duration, 100);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("超过 500 条会裁掉最老的", async () => {
  const d = mkDir();
  for (let i = 0; i < 510; i += 1) {
    vm.saveMeta(d, "BV" + String(i).padStart(6, "0"), { up: "u" + i });
  }
  const raw = JSON.parse(fs.readFileSync(path.join(d, "video-meta.json"), "utf8"));
  assert.ok(Object.keys(raw).length <= 500, "没裁剪");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 笔记自动补全");
await ta("模型什么都没传，也能补上", async () => {
  const d = mkDir();
  vm.saveMeta(d, "BV1xx411c7m2", { up: "观视频", duration: 2779, pubdate: 1792234800 });
  const n = vm.enrichNote(d, { source: "BV1xx411c7m2", title: "t" });
  assert.equal(n.duration, 2779, "时长没补上");
  assert.equal(n.pubdate, 1792234800);
  assert.equal(n.up, "观视频");
  assert.equal(n.bvid, "BV1xx411c7m2");
  assert.equal(n.cover, "BV1xx411c7m2.jpg");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("模型传了就不覆盖", async () => {
  const d = mkDir();
  vm.saveMeta(d, "BV1xx411c7m2", { up: "缓存里的", duration: 2779 });
  const n = vm.enrichNote(d, { source: "BV1xx411c7m2", up: "模型说的", duration: 100 });
  assert.equal(n.up, "模型说的");
  assert.equal(n.duration, 100);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("缓存里没有就原样返回", async () => {
  const d = mkDir();
  const n = vm.enrichNote(d, { source: "BVnope", title: "t", duration: 0 });
  assert.equal(n.duration, 0);
  assert.equal(n.bvid, "BVnope", "BV 还是要抽出来");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("source 是 BV: 前缀也能补", async () => {
  const d = mkDir();
  vm.saveMeta(d, "BV1v8pZ67Edb", { up: "我捞捞捞", duration: 1533 });
  const n = vm.enrichNote(d, { source: "BV:BV1v8pZ67Edb" });
  assert.equal(n.duration, 1533);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 接线");
t("bili_note 走 enrichNote", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  assert.ok(src.includes("videoMeta.enrichNote"), "note 没用自动补全");
});
t("bili_debrief 走 saveMeta", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  assert.ok(src.includes("videoMeta.saveMeta"), "debrief 没存元数据");
});
t("client.debrief 返回 pic（省一次请求）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/client.js"), "utf8");
  assert.ok(src.includes("pic: d.pic"), "缺 pic");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
