/**
 * verify/settings-check.mjs — 配置写入验证（P17：写 dataDir/config.json）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const settings = await import(pathToFileURL(path.join(APP, "lib/settings.js")).href);
const cfgmod = await import(pathToFileURL(path.join(APP, "lib/config.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "set-"));
}
const ctxOf = (d) => ({ dataDir: d });

console.log("[1] 写入白名单");
await ta("可写键落盘", async () => {
  const d = mkDir();
  const r = await settings.apply(ctxOf(d), { socialEnabled: true });
  assert.equal(r.ok, true, r.error);
  const onDisk = JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8"));
  assert.equal(onDisk.socialEnabled, true);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("非白名单键被拒", async () => {
  const d = mkDir();
  const r = await settings.apply(ctxOf(d), { hackTheGibson: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.rejected.includes("hackTheGibson"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("混合写入：好的进，坏的拒", async () => {
  const d = mkDir();
  const r = await settings.apply(ctxOf(d), { wakeMode: "brain", evil: 1 });
  assert.equal(r.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8"));
  assert.equal(onDisk.wakeMode, "brain");
  assert.equal(onDisk.evil, undefined, "坏键不该落盘");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 危险开关警告");
await ta("开 socialEnabled 会警告", async () => {
  const d = mkDir();
  const r = await settings.apply(ctxOf(d), { socialEnabled: true });
  assert.ok(r.warnings.some((w) => w.includes("socialEnabled")), JSON.stringify(r.warnings));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("开 publishLive 会警告", async () => {
  const d = mkDir();
  const r = await settings.apply(ctxOf(d), { publishLive: true });
  assert.ok(r.warnings.some((w) => w.includes("publishLive")));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("关掉不警告", async () => {
  const d = mkDir();
  await settings.apply(ctxOf(d), { publishLive: true });
  const r = await settings.apply(ctxOf(d), { publishLive: false });
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 回读确认");
await ta("写入后 now 反映新值", async () => {
  const d = mkDir();
  const r = await settings.apply(ctxOf(d), { scope: "reply-to-me,uid:100000001", wakeMode: "brain" });
  assert.deepEqual(r.now.scope, ["reply-to-me", "uid:100000001"]);
  assert.equal(r.now.wakeMode, "brain");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 自持：不依赖宿主 ctx.config");
await ta("只有 dataDir、没有 ctx.config 也能写", async () => {
  const d = mkDir();
  const r = await settings.apply({ dataDir: d }, { maxWakesPerDay: 5 });
  assert.equal(r.ok, true, r.error);
  const onDisk = JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8"));
  assert.equal(onDisk.maxWakesPerDay, 5);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("缺 dataDir → 明确报错", async () => {
  const r = await settings.apply({}, { wakeMode: "brain" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("dataDir"));
});

console.log("\n[5] 迁移：从宿主搬一次就不再来");
await ta("首次读配置：宿主值被搬到文件", async () => {
  const d = mkDir();
  const hostCtx = {
    dataDir: d,
    config: {
      async getAll() { return { ownerMid: "100000001", socialEnabled: true, personaName: "奥菲莉娅" }; },
    },
  };
  const c = await cfgmod.readConfig(hostCtx);
  assert.equal(c.ownerMid, "100000001");
  assert.equal(c.socialEnabled, true);
  assert.ok(fs.existsSync(path.join(d, "config.json")), "迁移后文件应存在");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("第二次读：文件优先，宿主变了也不跟", async () => {
  const d = mkDir();
  const ctx1 = { dataDir: d, config: { async getAll() { return { ownerMid: "111" }; } } };
  await cfgmod.readConfig(ctx1);
  const ctx2 = { dataDir: d, config: { async getAll() { return { ownerMid: "999" }; } } };
  const c = await cfgmod.readConfig(ctx2);
  assert.equal(c.ownerMid, "111", "文件是唯一事实源，不该被宿主覆盖");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("文件坏了不炸，回默认值", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "config.json"), "{ 坏 json");
  const c = await cfgmod.readConfig({ dataDir: d });
  assert.equal(c.personaName, "奥菲莉娅");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[6] manifest 不再声明宿主设置");
await ta("contributes 里没有 settings", () => {
  const j = JSON.parse(fs.readFileSync(path.join(APP, "manifest.json"), "utf8"));
  assert.ok(!j.contributes.settings, "宿主设置入口应该已撤掉");
});
await ta("设置是 Studio 内页签，不是独立卡片", () => {
  const j = JSON.parse(fs.readFileSync(path.join(APP, "manifest.json"), "utf8"));
  assert.ok(!j.contributes.cards.some((c) => c.id === "ophelia-bili-settings"),
    "不该再有独立设置卡（弹浏览器/多一张卡的根源）");
  const html = fs.readFileSync(path.join(APP, "ui/studio.html"), "utf8");
  assert.ok(html.includes('data-tab="settings"'), "Studio 应该有设置页签");
  assert.ok(html.includes('data-panel="settings"'), "Studio 应该有设置面板");
});
await ta("设置不再用 window.open 弹浏览器", () => {
  const js = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  assert.ok(!js.includes("window.open"), "不该再打开新窗口");
  assert.ok(js.includes('switchTab("settings")'), "应该在 Studio 内切页签");
});

console.log("\n[7] 默认值");
await ta("socialEnabled 默认 false", () => assert.equal(cfgmod.DEFAULTS.socialEnabled, false));
await ta("publishLive 默认 false", () => assert.equal(cfgmod.DEFAULTS.publishLive, false));
await ta("wakeMode 默认 brain", () => assert.equal(cfgmod.DEFAULTS.wakeMode, "brain"));
await ta("scope 默认 reply-to-me", () => assert.equal(cfgmod.DEFAULTS.scope, "reply-to-me"));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
