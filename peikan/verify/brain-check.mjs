/**
 * verify/brain-check.mjs — 脑子验证（纯逻辑 + 可选真机）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const brain = await import(pathToFileURL(path.join(APP, "lib/brain.js")).href);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-"));
fs.writeFileSync(path.join(tmpDir, "identity.json"), JSON.stringify({ agentId: "test-agent", agentName: "测试" }));
fs.writeFileSync(path.join(tmpDir, "persona.md"), "你是测试角色。");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

// ── 假 SDK ──
function fakeStream(chunks) {
  return {
    models: {
      async list() { return { models: [{ id: "test-model", provider: "test", isCurrent: true }] }; },
      async stream() {
        const enc = new TextEncoder();
        return {
          body: {
            getReader() {
              let i = 0;
              return {
                async read() {
                  if (i >= chunks.length) return { done: true };
                  return { done: false, value: enc.encode(chunks[i++]) };
                },
              };
            },
          },
        };
      },
    },
    bus: {
      async request(v, args) {
        if (v === "agent:profile") return { profile: { id: args.agentId, models: { provider: "test", model: "test-model" } } };
        return {};
      },
    },
  };
}

console.log("[1] 流式解析");
await ta("纯文本", async () => {
  const sdk = fakeStream([JSON.stringify({ type: "text-delta", delta: "你好" }) + "\n"]);
  const r = await brain.ask(sdk, tmpDir, { prompt: "hi", systemPrompt: "" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "你好");
});
await ta("多段拼接", async () => {
  const sdk = fakeStream([
    JSON.stringify({ type: "text-delta", delta: "前半" }) + "\n",
    JSON.stringify({ type: "text-delta", delta: "后半" }) + "\n",
  ]);
  const r = await brain.ask(sdk, tmpDir, { prompt: "hi", systemPrompt: "" });
  assert.equal(r.text, "前半后半");
});
await ta("跨 chunk 的行", async () => {
  const whole = JSON.stringify({ type: "text-delta", delta: "跨块" }) + "\n";
  const sdk = fakeStream([whole.slice(0, 10), whole.slice(10)]);
  const r = await brain.ask(sdk, tmpDir, { prompt: "hi", systemPrompt: "" });
  assert.equal(r.text, "跨块", `得到 "${r.text}"`);
});
await ta("error 事件被识别", async () => {
  const sdk = fakeStream([JSON.stringify({ type: "error", code: "RATE_LIMIT", message: "太快了" }) + "\n"]);
  const r = await brain.ask(sdk, tmpDir, { prompt: "hi", systemPrompt: "" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("太快了"));
});

console.log("\n[2] 模型选择");
await ta("agent 有配置时优先生效", async () => {
  const sdk = fakeStream([]);
  const m = await brain.pickModel(sdk, tmpDir);
  assert.equal(m.ok, true, m.error);
  assert.equal(m.provider, "test");
  assert.equal(m.model, "test-model");
  assert.equal(m.from, "agent");
});
await ta("agent 无配置时退回宿主目录", async () => {
  const sdk = {
    bus: { async request() { throw new Error("no agent"); } },
    models: { async list() { return { models: [{ id: "host-model", provider: "host", isCurrent: true }] }; } },
  };
  const m = await brain.pickModel(sdk, tmpDir);
  assert.equal(m.ok, true, m.error);
  assert.equal(m.from, "host-current");
  assert.equal(m.model, "host-model");
});

// 重要（2026-10-20 实测遇到过）：isCurrent 全 false → 绝不盲选第一个
await ta("isCurrent 全 false 时明确失败，不盲选 models[0]", async () => {
  const sdk2 = {
    models: {
      async list() {
        return {
          models: [
            { id: "first-maybe-dead", provider: "p1", isCurrent: false },
            { id: "second", provider: "p2", isCurrent: false },
          ],
        };
      },
    },
  };
  const m2 = await brain.pickModel(sdk2, tmpDir);
  assert.equal(m2.ok, false, "不能盲选");
  assert.ok(String(m2.error).includes("当前模型"), "错误要说清楚");
  assert.equal(m2.candidates.length, 2, "要把候选列出来");
});

await ta("override 优先于一切", async () => {
  const m3 = await brain.pickModel(
    { models: { async list() { return { models: [{ id: "x", provider: "x", isCurrent: true }] }; } } },
    tmpDir,
    { provider: "explicitP", model: "explicitM" }
  );
  assert.equal(m3.from, "explicit");
  assert.equal(m3.model, "explicitM");
});
await ta("都没有时明确失败", async () => {
  const m = await brain.pickModel({}, tmpDir);
  assert.equal(m.ok, false);
  assert.ok(m.error.includes("拿不到"));
});

console.log("\n[3] 工具循环");
await ta("无工具调用 → 直接返回", async () => {
  const sdk = fakeStream([JSON.stringify({ type: "text-delta", delta: "完成" }) + "\n"]);
  const r = await brain.think(sdk, tmpDir, {
    prompt: "hi", systemPrompt: "", tools: [],
    runTool: async () => "x",
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "完成");
  assert.equal(r.rounds, 1);
});
await ta("一次工具调用后返回答案", async () => {
  let call = 0;
  const sdk = {
    bus: { async request() { return { profile: { models: { provider: "t", model: "m" } } }; } },
    models: {
      async stream() {
        call += 1;
        const evs = call === 1
          ? [{ type: "tool-call", id: "c1", name: "peek", arguments: { bv: "BV1" } }]
          : [{ type: "text-delta", delta: "看完了，不错" }];
        const enc = new TextEncoder();
        return {
          body: {
            getReader() {
              let i = 0;
              return {
                async read() {
                  if (i >= evs.length) return { done: true };
                  return { done: false, value: enc.encode(JSON.stringify(evs[i++]) + "\n") };
                },
              };
            },
          },
        };
      },
    },
  };
  const tools = [{ name: "peek", description: "看一眼", parameters: { type: "object", properties: {} } }];
  const r = await brain.think(sdk, tmpDir, {
    prompt: "看看 BV1", systemPrompt: "", tools,
    runTool: async (name) => { assert.equal(name, "peek"); return "视频内容"; },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "看完了，不错");
  assert.equal(r.rounds, 2);
  assert.equal(r.trace.length, 1);
  assert.equal(r.trace[0].tool, "peek");
});
await ta("工具循环超限 → 主动停手", async () => {
  const sdk = {
    bus: { async request() { return { profile: { models: { provider: "t", model: "m" } } }; } },
    models: {
      async stream() {
        const enc = new TextEncoder();
        const evs = [{ type: "tool-call", id: "c", name: "loop", arguments: {} }];
        return {
          body: {
            getReader() {
              let i = 0;
              return {
                async read() {
                  if (i >= evs.length) return { done: true };
                  return { done: false, value: enc.encode(JSON.stringify(evs[i++]) + "\n") };
                },
              };
            },
          },
        };
      },
    },
  };
  const r = await brain.think(sdk, tmpDir, {
    prompt: "hi", systemPrompt: "", tools: [{ name: "loop", description: "", parameters: {} }],
    runTool: async () => "again", maxRounds: 3,
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("超过"));
  assert.equal(r.trace.length, 3);
});
await ta("工具抛错不影响循环", async () => {
  let call = 0;
  const sdk = {
    bus: { async request() { return { profile: { models: { provider: "t", model: "m" } } }; } },
    models: {
      async stream() {
        call += 1;
        const enc = new TextEncoder();
        const evs = call === 1
          ? [{ type: "tool-call", id: "c1", name: "bad", arguments: {} }]
          : [{ type: "text-delta", delta: "工具挂了但我知道" }];
        return {
          body: {
            getReader() {
              let i = 0;
              return {
                async read() {
                  if (i >= evs.length) return { done: true };
                  return { done: false, value: enc.encode(JSON.stringify(evs[i++]) + "\n") };
                },
              };
            },
          },
        };
      },
    },
  };
  const r = await brain.think(sdk, tmpDir, {
    prompt: "hi", systemPrompt: "", tools: [{ name: "bad", description: "", parameters: {} }],
    runTool: async () => { throw new Error("boom"); },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.trace[0].isError, true);
});

console.log("\n[4] 缺能力时优雅失败");
await ta("无 models.stream → ok:false", async () => {
  const r = await brain.ask({}, tmpDir, { prompt: "hi" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("models.stream"));
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
