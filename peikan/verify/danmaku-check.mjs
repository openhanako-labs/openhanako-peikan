/**
 * verify/danmaku-check.mjs — 弹幕热区验证
 *
 * 1. XML 解析正确
 * 2. 密度曲线分桶对
 * 3. 高能时刻能找出来
 * 4. 低质量弹幕被过滤
 * 5. 真网络：拉到真实弹幕
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const dm = await import(pathToFileURL(path.join(APP, "lib/danmaku.js")).href);
const client = await import(pathToFileURL(path.join(APP, "lib/client.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

console.log("[1] XML 解析");
const sampleXml = `<i><d p="1.5,1,25,16777215,1700000000,0,abc,1">全体起立</d>
<d p="3.2,1,25,16777215,1700000001,0,def,2">爷青回</d>
<d p="5.0,1,25,16777215,1700000002,0,ghi,3">太难了 &amp; 好听</d></i>`;
t("解析出 3 条", () => {
  const items = dm.parseXml(sampleXml);
  assert.equal(items.length, 3);
});
t("时间和内容正确", () => {
  const items = dm.parseXml(sampleXml);
  assert.equal(items[0].t, 1.5);
  assert.equal(items[0].text, "全体起立");
  assert.equal(items[2].text, "太难了 & 好听");
});

console.log("\n[2] 密度曲线");
t("按 10 秒分桶", () => {
  const items = [
    { t: 1, text: "a" }, { t: 5, text: "b" }, { t: 12, text: "c" },
  ];
  const curve = dm.densityCurve(items, 30, 10);
  assert.equal(curve.length, 3);
  assert.equal(curve[0].count, 2);
  assert.equal(curve[1].count, 1);
  assert.equal(curve[2].count, 0);
});
t("rate 归一化到 0-1", () => {
  const curve = dm.densityCurve([{ t: 1, text: "a" }, { t: 2, text: "b" }, { t: 15, text: "c" }], 30, 10);
  assert.equal(curve[0].rate, 1);
  assert.ok(curve[2].rate === 0);
});

console.log("\n[3] 高能时刻");
t("密度峰值被找出来", () => {
  // 0-10s 塞 10 条，其余稀疏
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ t: i * 0.5, text: `炸${i}` });
  items.push({ t: 60, text: "冷" });
  const hot = dm.hotMoments(items, 120, { bucketSec: 10, top: 3, minMultiple: 2 });
  assert.ok(hot.length >= 1, "没找到高能时刻");
  assert.equal(hot[0].at, 0);
});
t("稀疏内容不误报", () => {
  const items = [{ t: 5, text: "a" }, { t: 50, text: "b" }, { t: 100, text: "c" }];
  const hot = dm.hotMoments(items, 120, { bucketSec: 10, top: 3, minMultiple: 2 });
  assert.equal(hot.length, 0, `不该有高能时刻，却找到 ${hot.length} 个`);
});
t("高能时刻带样句", () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push({ t: i, text: `这句话有内容${i}` });
  const hot = dm.hotMoments(items, 60, { bucketSec: 10, top: 1 });
  assert.ok(hot[0].samples.length > 0, "样句为空");
});

console.log("\n[4] 低质量弹幕过滤");
t("纯「哈哈哈」被剔除", () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ t: i, text: "哈哈哈哈" });
  items.push({ t: 1, text: "这句话有实际内容" });
  const hot = dm.hotMoments(items, 60, { bucketSec: 10, top: 1 });
  if (hot.length) {
    assert.ok(hot[0].samples.every((s) => !/^哈+$/.test(s)), "样句里还有纯哈");
  }
});
t("纯表情代码被剔除", () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ t: i, text: "[笑哭]" });
  items.push({ t: 2, text: "这才是真话" });
  const hot = dm.hotMoments(items, 60, { bucketSec: 10, top: 1 });
  if (hot.length) {
    assert.ok(hot[0].samples.every((s) => !/^\[[^\]]+\]$/.test(s)), "样句里还有纯表情");
  }
});

console.log("\n[5] 真网络");
const dirs = [process.env.OPHELIA_DATA_DIR, process.env.OPHELIA_DATA_DIR || path.join(os.homedir(), ".hanako", "app-data", "peikan"), path.join(os.homedir(), ".hanako", "app-data", "ophelia-bili")].filter(Boolean);
let dataDir = null;
for (const d of dirs) { if (fs.existsSync(path.join(d, "credentials.json"))) { dataDir = d; break; } }

if (!dataDir) {
  console.log("  (跳过：找不到凭据)");
} else {
  const sdk = { network: { async fetch(u, i) { return fetch(u, i); } } };
  await ta("拉到真实弹幕", async () => {
    const info = await client.videoInfo(sdk, dataDir, { bvid: "BV1xx411c7m3" });
    assert.ok(info.ok);
    const r = await dm.analyze(sdk, dataDir, { cid: info.video.cid, duration: info.video.duration });
    assert.ok(r.ok, r.note);
    assert.ok(r.total > 50, `弹幕太少：${r.total}`);
    assert.ok(Array.isArray(r.hotMoments), "hotMoments 不是数组");
  });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
