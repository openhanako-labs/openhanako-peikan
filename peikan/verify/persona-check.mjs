/**
 * verify/persona-check.mjs — 人格分层（2026-10-20 定案）
 *
 * 优先级：
 *   ① personas/<agentId>.md         用户覆盖版
 *   ② agents/<id>/identity.md + AGENTS.md   助手自己的
 *   ③ persona.md                    旧版全局兜底
 *   ④ DEFAULT_PERSONA
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const id = await import(pathToFileURL(path.join(APP, "lib/identity.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));

console.log("[1] 覆盖版：按助手分开");
await ta("写 A 的覆盖，不影响 B", async () => {
  const d = mkDir();
  id.writeOverride(d, "ophelia", "A 的覆盖版");
  id.writeOverride(d, "aimis", "B 的覆盖版");
  assert.equal(id.readOverride(d, "ophelia"), "A 的覆盖版");
  assert.equal(id.readOverride(d, "aimis"), "B 的覆盖版");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("没有覆盖版 → 空串", async () => {
  const d = mkDir();
  assert.equal(id.readOverride(d, "nobody"), "");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("删除覆盖版", async () => {
  const d = mkDir();
  id.writeOverride(d, "ophelia", "x");
  const r = id.clearOverride(d, "ophelia");
  assert.equal(r.removed, true);
  assert.equal(id.readOverride(d, "ophelia"), "");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("agentId 里的危险字符被过滤", async () => {
  const d = mkDir();
  const p = id.overridePath(d, "../../etc/passwd");
  assert.ok(!p.includes(".."));
  assert.ok(p.startsWith(path.join(d, "personas")));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] resolvePersona 的优先级");
const fakeCtxWithFiles = (files) => ({
  resources: {
    async stat() { return { exists: true }; },   // 目录总是存在（真实环境里也是）
    async read({ path: p }) {
      const key = Object.keys(files).find((k) => p.endsWith(k));
      if (!key) throw new Error("not found");
      const buf = Buffer.from(files[key], "utf8");
      const content = {};
      for (let i = 0; i < buf.length; i += 1) content[String(i)] = buf[i];
      return { content };
    },
  },
});

await ta("有覆盖版 → 用覆盖版（最高优先）", async () => {
  const d = mkDir();
  id.writeOverride(d, "ophelia", "这是我的覆盖版");
  const ctx = fakeCtxWithFiles({ "identity.md": "助手原文" });
  const r = await id.resolvePersona(ctx, d, "ophelia");
  assert.equal(r.source, "override");
  assert.equal(r.persona, "这是我的覆盖版");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("没有覆盖版但有助手文件 → 用助手文件", async () => {
  const d = mkDir();
  const ctx = fakeCtxWithFiles({
    "identity.md": "我是奥菲莉娅",
    "AGENTS.md": "我的工作纪律",
  });
  const r = await id.resolvePersona(ctx, d, "ophelia");
  assert.equal(r.source, "agent-files");
  assert.ok(r.persona.includes("我是奥菲莉娅"));
  assert.ok(r.persona.includes("我的工作纪律"), "两份都要拼");
  assert.ok(r.persona.includes("[identity.md]"), "要标出处");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("都读不到 → 用本地 persona.md", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "persona.md"), "本地那份");
  const ctx = { resources: { async stat() { return { exists: false }; }, async read() { throw new Error("no"); } } };
  const r = await id.resolvePersona(ctx, d, "ophelia");
  assert.equal(r.source, "local");
  assert.equal(r.persona, "本地那份");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("连本地都没有 → 默认", async () => {
  const d = mkDir();
  const ctx = { resources: { async stat() { return { exists: false }; }, async read() { throw new Error("no"); } } };
  const r = await id.resolvePersona(ctx, d, "nobody");
  assert.equal(r.source, "default");
  assert.equal(r.persona, id.DEFAULT_PERSONA);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("切换助手 → 人格跟着变", async () => {
  const d = mkDir();
  const ctx = {
    resources: {
      async stat({ path: p }) { return { exists: p.includes("ophelia") || p.includes("aimis") }; },
      async read({ path: p }) {
        const who = p.includes("ophelia") ? "奥菲莉娅" : "爱弥斯";
        const buf = Buffer.from(who, "utf8");
        const content = {};
        for (let i = 0; i < buf.length; i += 1) content[String(i)] = buf[i];
        return { content };
      },
    },
  };
  const a = await id.resolvePersona(ctx, d, "ophelia");
  const b = await id.resolvePersona(ctx, d, "aimis");
  assert.notEqual(a.persona, b.persona, "不同助手必须读到不同的人格");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 接口契约");
t("/persona GET 返回 source", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-routes.js"), "utf8");
  const i = src.indexOf('app.get("/persona"');
  const block = src.slice(i, i + 600);
  assert.ok(block.includes("resolvePersona"), "GET 应该用 resolvePersona");
  assert.ok(block.includes("source"), "要返回来源");
});
t("/persona POST 写覆盖版", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-routes.js"), "utf8");
  const i = src.indexOf('app.post("/persona"');
  const block = src.slice(i, i + 700);
  assert.ok(block.includes("writeOverride"), "应该写覆盖版，不是写助手文件");
});
t("/persona/reset 存在", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-routes.js"), "utf8");
  assert.ok(src.includes('app.post("/persona/reset"'), "缺恢复接口");
});
t("切换后前端重读人格", () => {
  const src = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  const i = src.indexOf("currentAgentId = id2");
  const block = src.slice(i, i + 300);
  assert.ok(block.includes("loadPersona()"), "切换后没重读");
});
t("界面显示来源", () => {
  const src = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
  assert.ok(src.includes("来源："), "没显示来源");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
