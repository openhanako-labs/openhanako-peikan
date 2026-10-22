/**
 * verify/round-decouple-check.mjs — 回合解耦验证（P0，2026-10-22）
 *
 * 由来：他私信/评论里回了她，她回完话，同一个回合里又推了一条视频给他。
 * 也就是「回复」和「分享」挤在同一轮里，于是每条回复都捎带一条视频。
 *
 * 修法（结构性，不靠 prompt）：一个回合只做一类对外动作——
 *   social  回合的工具表里没有 bili_share / bili_comment / bili_follow…
 *   content 回合的工具表里没有 bili_reply
 * 加上：shareToOwner 自动分享在 social 回合直接跳过（代码门兜底）。
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
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "round-"));
  fs.writeFileSync(path.join(d, "identity.json"), JSON.stringify({ agentId: "a1", agentName: "奥菲莉娅" }));
  fs.writeFileSync(path.join(d, "persona.md"), "你是奥菲莉娅。");
  fs.mkdirSync(path.join(d, "notes"), { recursive: true });
  fs.writeFileSync(path.join(d, "notes", "index.json"), "[]");
  return d;
}
function fakeSdk(behavior) {
  let round = 0;
  return {
    models: {
      async list() { return { models: [{ id: "m1", provider: "p1", isCurrent: true }] }; },
      async stream() {
        round += 1;
        const evs = behavior(round) || [];
        const enc = new TextEncoder();
        return { body: { getReader() { let i = 0; return { async read() { if (i >= evs.length) return { done: true }; return { done: false, value: enc.encode(JSON.stringify(evs[i++]) + "\n") }; } }; } } };
      },
    },
    bus: { async request(v, args) { if (v === "agent:profile") return { profile: { id: args.agentId, models: { provider: "p1", model: "m1" } } }; return {}; } },
    network: { async fetch(u) { return { json: async () => ({ code: 0, data: { item: [] } }) }; } },
  };
}

console.log("[1] toolsForRound 是存在的导出");
t("toolsForRound 是函数", () => assert.equal(typeof wake.toolsForRound, "function"));

console.log("\n[2] social 回合：没有分享/评论的手，只有回话的手");
t("social 回合含 bili_inbox / bili_reply", () => {
  const names = wake.toolsForRound("social").map((x) => x.name);
  assert.ok(names.includes("bili_inbox"), "缺 bili_inbox");
  assert.ok(names.includes("bili_reply"), "缺 bili_reply");
});
t("social 回合不含 bili_share", () => {
  const names = wake.toolsForRound("social").map((x) => x.name);
  assert.ok(!names.includes("bili_share"), "social 回合不该有 bili_share");
});
t("social 回合不含 bili_comment / bili_note / bili_feed", () => {
  const names = wake.toolsForRound("social").map((x) => x.name);
  for (const n of ["bili_comment", "bili_note", "bili_feed"]) {
    assert.ok(!names.includes(n), `social 回合不该有 ${n}`);
  }
});

console.log("\n[3] content 回合：没有回话的手");
t("content 回合不含 bili_reply", () => {
  const names = wake.toolsForRound("content").map((x) => x.name);
  assert.ok(!names.includes("bili_reply"), "content 回合不该有 bili_reply");
});
t("content 回合含 bili_share / bili_feed / bili_note", () => {
  const names = wake.toolsForRound("content").map((x) => x.name);
  for (const n of ["bili_share", "bili_feed", "bili_note"]) {
    assert.ok(names.includes(n), `content 回合缺 ${n}`);
  }
});

console.log("\n[4] 两个回合的工具集不重叠于对外动作");
t("bili_reply 只在 social；bili_share 只在 content", () => {
  const social = new Set(wake.toolsForRound("social").map((x) => x.name));
  const content = new Set(wake.toolsForRound("content").map((x) => x.name));
  assert.ok(social.has("bili_reply") && !content.has("bili_reply"), "bili_reply 归属错");
  assert.ok(content.has("bili_share") && !social.has("bili_share"), "bili_share 归属错");
});

console.log("\n[5] 代码门：social 回合不自动分享");
t("wakeOnce 里自动分享分支排除了 social", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  assert.ok(src.includes('cfg.round !== "social" && cfg.shareToOwner'), "自动分享没排除 social 回合");
});

console.log("\n[6] 深度兜底：social 回合里调用写手会被挡");
t("makeToolRunner 对 bili_share 在 social 回合返回拒绝", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('if (name === "bili_share")');
  const block = src.slice(i, i + 260);
  assert.ok(block.includes('cfg.round === "social"'), "bili_share 没做 social 回合校验");
});
t("makeToolRunner 对 bili_reply 在非 social 回合返回拒绝", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('if (name === "bili_reply")');
  const block = src.slice(i, i + 260);
  assert.ok(block.includes('cfg.round !== "social"'), "bili_reply 没做回合校验");
});

console.log("\n[7] 接线：每个入口都指定了回合");
t("rhythm.wake 走 content 回合", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  const i = src.indexOf("[rhythm.wake]");
  const block = src.slice(0, src.indexOf('round: "content"'));
  assert.ok(block.includes("wake.wakeOnce"), "rhythm.wake 没指定 round:content");
});
t("inbox.tick 走 social 回合（且强制 brain）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  const i = src.indexOf('round: "social"');
  assert.ok(i > 0, "inbox.tick 没指定 round:social");
  const block = src.slice(i - 80, i + 220);
  assert.ok(block.includes('wakeMode: "brain"'), "social 回合没强制 brain");
});

console.log("\n[8] 真实跑一轮 social：模型要分享也分享不出去");
await ta("social 回合 → share 字段 sent:false 且不分享", async () => {
  const d = mkDir();
  // 模型想写笔记 + 想分享；但 social 回合里这两个工具都不该在表里
  const sdk = fakeSdk((round) => {
    if (round === 1) return [{ type: "tool-call", id: "c1", name: "bili_note", arguments: { summary: "x", kind: "video", source: "BVsocialround" } }];
    return [{ type: "text-delta", delta: "ok" }];
  });
  const r = await wake.wakeOnce(sdk, d, { round: "social", wakeMode: "brain", skipChance: 0, shareToOwner: true, ownerMid: "100000001" }, null);
  assert.ok(r.share, "应返回 share 字段");
  assert.equal(r.share.sent, false, "social 回合不该分享");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
