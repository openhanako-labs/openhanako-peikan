/**
 * verify/social-skip-check.mjs — 有人找她的时候，不掷「今天不想看」（2026-10-23）
 *
 * 由来：skipChance 原来不分回合。于是「他刚私信她」这件也会被那 30% 拦住 ——
 * 人家找她，她整轮跳过，连话都不回。日志上看就是「没看」，看不出「没理人」。
 *
 * 分界：看不看是她的事（可以掷骰），回不回是别人的事（不能掷骰）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const wake = await import(pathToFileURL(path.join(APP, "lib/wake.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "socialskip-"));
  fs.writeFileSync(path.join(d, "identity.json"), JSON.stringify({ agentId: "a1", agentName: "奥菲莉娅" }));
  fs.writeFileSync(path.join(d, "persona.md"), "你是奥菲莉娅。");
  fs.mkdirSync(path.join(d, "notes"), { recursive: true });
  fs.writeFileSync(path.join(d, "notes", "index.json"), "[]");
  return d;
}

/** 最小 sdk：模型回一句话，然后空回合结束 */
function fakeSdk() {
  let round = 0;
  const enc = new TextEncoder();
  return {
    models: {
      async list() { return { models: [{ id: "m1", provider: "p1", isCurrent: true }] }; },
      async stream() {
        round += 1;
        const evs = round === 1 ? [{ type: "text-delta", delta: "我在。" }] : [];
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
    bus: {
      async request(v, args) {
        if (v === "agent:profile") return { profile: { id: args.agentId, models: { provider: "p1", model: "m1" } } };
        return {};
      },
    },
    network: { async fetch() { return { json: async () => ({ code: 0, data: { item: [] } }) }; } },
  };
}

console.log("[1] social 回合：概率拉满也不跳过");
await ta("skipChance=1 + round=social → 不被跳过", async () => {
  const d = mkDir();
  try {
    const r = await wake.withBrain(fakeSdk(), d, {
      round: "social", skipChance: 1, wakeMode: "brain",
      inboxHint: [{ who: "主人", kind: "dm", body: "在吗" }],
    });
    assert.notEqual(r.skipped, true, "有人找她却整轮跳过了");
    assert.ok(!String(r.reason || "").includes("不想看"), `理由还写着不想看：${r.reason}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[2] content 回合：该跳过还是跳过（她有权安静）");
await ta("skipChance=1 + round=content → 跳过", async () => {
  const d = mkDir();
  try {
    const r = await wake.withBrain(fakeSdk(), d, { round: "content", skipChance: 1, wakeMode: "brain" });
    assert.equal(r.skipped, true, "这不看的时候没跳过");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
await ta("skipChance=0 + round=content → 正常跑", async () => {
  const d = mkDir();
  try {
    const r = await wake.withBrain(fakeSdk(), d, { round: "content", skipChance: 0, wakeMode: "brain" });
    assert.notEqual(r.skipped, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
