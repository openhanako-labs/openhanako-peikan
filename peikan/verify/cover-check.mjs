/**
 * verify/cover-check.mjs — 封面 / substrip / 图片路由
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const frames = await import(pathToFileURL(path.join(APP, "lib/frames.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cover-"));

console.log("[1] 封面：参数与缓存");
await ta("缺 bvid → 报错", async () => {
  const r = await frames.cover({}, mkDir(), {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("bvid"));
});
await ta("有本地缓存就不重复下", async () => {
  const d = mkDir();
  const dir = path.join(d, "covers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "BV1cached.jpg"), Buffer.alloc(100));
  const r = await frames.cover({}, d, { bvid: "BV1cached" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.cached, true);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("写进 dataDir/covers（不越界）", async () => {
  const d = mkDir();
  fs.mkdirSync(path.join(d, "covers"), { recursive: true });
  fs.writeFileSync(path.join(d, "covers", "BV1x.jpg"), Buffer.alloc(10));
  const r = await frames.cover({}, d, { bvid: "BV1x" });
  assert.ok(String(r.cover).startsWith(path.resolve(d)), "封面跑到 dataDir 外面了");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] substrip：参数");
await ta("缺 cid → 报错", async () => {
  const r = await frames.substrip({}, mkDir(), { bvid: "BV1x" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("cid"));
});
await ta("先数实际抽到几张，再拼图（不按容器时长硬算）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  // 关键：不能直接 tile=1x{rows}，必须先把帧抽到目录里数一数
  assert.ok(src.includes("f%03d.jpg"), "没有分两步抽帧");
  assert.ok(src.includes("readdirSync(frameDir)"), "没数实际帧数");
});
await ta("裁剪位置避开正文又不切断字", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(!src.includes("crop=iw:ih*0.32:0:ih*0.57"), "旧的裁切位置会切在字中间");
  assert.ok(src.includes("crop=iw:ih*0.30:0:ih*0.68"), "裁切位置不对");
});

console.log("\n[3] 图片路由");
t("有 /frame 路由，且限制在 dataDir 内", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-routes.js"), "utf8");
  assert.ok(src.includes('app.get("/frame"'), "没有 /frame 路由");
  assert.ok(src.includes("startsWith(root + path.sep)"), "没有路径围栏");
});
t("支持 cover / strip / sheet 三种", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-routes.js"), "utf8");
  for (const k of ["cover:", "strip:", "sheet:"]) {
    assert.ok(src.includes(k), `缺 ${k}`);
  }
});
t("sheet 要扫目录（文件名带格子尺寸）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-routes.js"), "utf8");
  assert.ok(src.includes("readdirSync(dir)"), "sheet 路径写死了尺寸，换个格子就 404");
});

console.log("\n[4] 前端渲染");
t("笔记列表用 source 拼封面，失败时隐藏整块", () => {
  const js = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  // 现在不写 src，改用 data-cover + fetch 取 blob（file:// 源下 http 图片会 403）
  assert.ok(js.includes("data-cover"), "没写 data-cover");
  assert.ok(js.includes("loadImageInto"), "没有 blob 加载函数");
  assert.ok(js.includes("parentNode.style.display"), "图失败时没隐藏");
});
t("带封面的行是三列布局", () => {
  const css = fs.readFileSync(path.join(APP, "ui/assets/studio.css"), "utf8");
  assert.ok(css.includes(":has(.cover)"), "没有三列布局规则");
});

console.log("\n[5] debrief 工具暴露了两条新路");
t("bili_debrief 有 substrip 参数", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  const i = src.indexOf('name: "bili_debrief"');
  const block = src.slice(i, i + 1800);
  assert.ok(block.includes("substrip:"), "没暴露 substrip");
  assert.ok(block.includes("frames.cover"), "没调封面");
});

console.log("\n[HTTPS 协议]");

t("封面下载会把 http:// 升成 https://", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(
    src.includes('replace(/^http:\\/\\//i, "https://")'),
    "没做协议升级 —— 宿主只允许 HTTPS，B站 CDN 给的是 http://"
  );
});

t("视频流地址也会升协议", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(src.includes("forceHttps"), "找不到 forceHttps");
  assert.ok(src.includes("forceHttps(d.url)"), "主链没升协议");
  assert.ok(src.includes("forceHttps(alt)"), "备选链没升协议");
});

t("缓存里的 pic 存成 https", () => {
  const src = fs.readFileSync(path.join(APP, "lib/video-meta.js"), "utf8");
  const i = src.indexOf("pic:");
  assert.ok(i > 0, "找不到 pic 字段");
  const block = src.slice(i, i + 300);
  assert.ok(block.includes("https://"), "pic 存的时候没转协议");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
