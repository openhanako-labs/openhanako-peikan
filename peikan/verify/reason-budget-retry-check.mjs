/**
 * verify/reason-budget-retry-check.mjs — P2-1 推理吃空预算自动翻倍重试验证
 *
 * 模拟：模型第一次调用返回「全 reasoning、无正文、无工具调用」→ 应翻倍预算重试；
 *      第二次返回正常 → 应 ok。
 * 断言：stream 被调用 2 次；第二次 maxTokens 是第一次的 2 倍；最终 ok。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const brain = await import(pathToFileURL(path.join(APP, "lib/brain.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-"));
fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ agentId: "t", agentName: "t" }));
fs.writeFileSync(path.join(dir, "persona.md"), "你是测试。");
fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
fs.writeFileSync(path.join(dir, "notes", "index.json"), "[]");

/** 造 stream：第 1 次吃空预算（无正文无工具），第 2 次正常（有正文）。记录每次 maxTokens。 */
function build(seq) {
  const calls = [];
  const budgets = [];
  return {
    calls, budgets,
    models: {
      async list() { return { models: [{ id: "reasoner", provider: "p", isCurrent: true }] }; },
      async stream(req) {
        calls.push(req);
        budgets.push(Number(req.maxTokens));
        const round = calls.length;
        const events = seq[round - 1];
        const enc = new TextEncoder();
        const raw = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
        return { body: { getReader() { let i = 0; const lines = raw.split("\n"); return { async read() { if (i >= lines.length) return { done: true }; return { done: false, value: enc.encode(lines[i++] + "\n") }; } }; } } };
      },
    },
    bus: { async request(v) { if (v === "agent:profile") return { profile: { models: { provider: "p", model: "reasoner" } } }; return {}; } },
    network: { async fetch() { return { json: async () => ({ code: 0, data: {} }) }; } },
  };
}

// 第1次：仅 reasoning-delta（吃空预算）；第2次：text-delta（成功，无工具调用直接给最终回答）
const eat = [{ type: "reasoning-delta", delta: "想了很多很多关于这个视频的内容，试图理解播放量背后的逻辑。" }];
const okCall = [{ type: "text-delta", delta: "这条真值得看，妙在标题的反差。" }];

console.log("[1] 推理吃空预算 → 自动翻倍重试一次 → 成功");
await ta("stream 调用 2 次，第二次预算翻倍，最终 ok", async () => {
  const sdk = build([eat, okCall]);
  const r = await brain.think(sdk, dir, {
    prompt: "看看这条", tools: [], runTool: async () => "",
    systemPrompt: "你是测试", maxTokens: 1000,
  });
  assert.equal(sdk.calls.length, 2, `应调用 2 次，实际 ${sdk.calls.length}`);
  assert.equal(sdk.budgets[1], sdk.budgets[0] * 2, `第二次预算应翻倍：${sdk.budgets.join("→")}`);
  assert.equal(r.ok, true, r.error);
  assert.ok(String(r.text || "").includes("真值得看"), "应取到第二次的正文");
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log("\n[2] 已重试过一次后再次吃空 → 不再重试（防止死循环）");
await ta("第二次仍吃空则返回 ok:false 且只调 2 次", async () => {
  const sdk = build([eat, eat]);
  const r = await brain.think(sdk, dir, {
    prompt: "x", tools: [], runTool: async () => "", systemPrompt: "s", maxTokens: 1000,
  });
  assert.equal(sdk.calls.length, 2, `到达重试上限应正好 2 次，实际 ${sdk.calls.length}`);
  assert.equal(r.ok, false, "两次都吃空应失败");
  assert.ok(String(r.error || "").includes("吃空"), `错误应说明吃空：${r.error}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log("\n[3] 一次成功 → 只调 1 次（不无谓重试）");
await ta("正常完成只调一次", async () => {
  const sdk = build([okCall]);
  const r = await brain.think(sdk, dir, { prompt: "x", tools: [], runTool: async () => "", systemPrompt: "s", maxTokens: 500 });
  assert.equal(sdk.calls.length, 1, `应只调 1 次，实际 ${sdk.calls.length}`);
  assert.equal(r.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);