/**
 * verify/wake-check.mjs — 醒来调度验证（兜底是关键）
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wake-"));
  fs.writeFileSync(path.join(d, "identity.json"), JSON.stringify({ agentId: "a1", agentName: "奥菲莉娅" }));
  fs.writeFileSync(path.join(d, "persona.md"), "你是奥菲莉娅。");
  fs.mkdirSync(path.join(d, "notes"), { recursive: true });
  fs.writeFileSync(path.join(d, "notes", "index.json"), "[]");
  return d;
}

/** 假 sdk：可由外部控制模型行为 */
function fakeSdk(behavior) {
  let round = 0;
  return {
    models: {
      async list() { return { models: [{ id: "m1", provider: "p1", isCurrent: true }] }; },
      async stream(req) {
        round += 1;
        const evs = behavior(round, req) || [];
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
    bus: {
      async request(v, args) {
        if (v === "agent:profile") return { profile: { id: args.agentId, models: { provider: "p1", model: "m1" } } };
        return {};
      },
    },
    network: { async fetch(u, i) { return fetch(u, i); } },
  };
}

console.log("[1] 掷到「不想看」→ 不花 token");
await ta("skip 时不调模型", async () => {
  const d = mkDir();
  let called = 0;
  const sdk = fakeSdk(() => { called += 1; return []; });
  const r = await wake.withBrain(sdk, d, { skipChance: 1 }, null);
  assert.equal(r.skipped, true);
  assert.equal(called, 0, "skip 时不该调模型");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 模型写了笔记 → 直接用");
await ta("模型写 1 条 → wrote=1, 不兜底", async () => {
  const d = mkDir();
  const sdk = fakeSdk((round) => {
    if (round === 1) return [{ type: "tool-call", id: "c1", name: "bili_note", arguments: { summary: "她自己的判断", kind: "video" } }];
    return [{ type: "text-delta", delta: "写完了" }];
  });
  // 让 bili_note 能写进临时目录
  const r = await wake.withBrain(sdk, d, { skipChance: 0 }, null);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.wrote, 1, `wrote=${r.wrote}`);
  assert.equal(r.fallback, false);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 模型没写 → 兜底（核心）");
await ta("模型只说话不写笔记 → fallback=true", async () => {
  const d = mkDir();
  const sdk = fakeSdk(() => [{ type: "text-delta", delta: "今天没什么好看的" }]);
  const r = await wake.withBrain(sdk, d, { skipChance: 0 }, null);
  assert.equal(r.ok, true);
  assert.equal(r.wrote, 0);
  assert.equal(r.fallback, true, "没写笔记必须标记兜底");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 模型报错 → 也兜底");
await ta("error 事件 → fallback=true", async () => {
  const d = mkDir();
  const sdk = fakeSdk(() => [{ type: "error", code: "RATE_LIMIT", message: "太快" }]);
  const r = await wake.withBrain(sdk, d, { skipChance: 0 }, null);
  assert.equal(r.ok, false);
  assert.equal(r.fallback, true);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[5] 模式分派");
await ta("wakeMode=rule → 不碰模型", async () => {
  const d = mkDir();
  let called = 0;
  const sdk = fakeSdk(() => { called += 1; return []; });
  // rule 模式会走 browse.runOnce，需要 network；用假网络返回空流
  sdk.network = {
    async fetch(url) {
      return { json: async () => ({ code: 0, data: { item: [] } }) };
    },
  };
  const r = await wake.wakeOnce(sdk, d, { wakeMode: "rule", maxVideos: 3, deepRead: 1 }, null);
  assert.equal(r.mode, "rule");
  assert.equal(called, 0, "rule 模式不该调模型");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("wakeMode 未设 → 默认 rule", async () => {
  const d = mkDir();
  const sdk = fakeSdk(() => []);
  sdk.network = { async fetch() { return { json: async () => ({ code: 0, data: { item: [] } }) }; } };
  const r = await wake.wakeOnce(sdk, d, {}, null);
  assert.equal(r.mode, "rule");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[6] 工具声明不含发布");
await ta("TOOLS 里没有 bili_publish", () => {
  const names = wake.makeToolRunner ? [] : [];
  // 通过模块常量检查
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const toolBlock = src.slice(src.indexOf("const TOOLS = ["), src.indexOf("];", src.indexOf("const TOOLS = [")));
  assert.ok(!toolBlock.includes("bili_publish"), "工具声明里出现了 bili_publish");
  assert.ok(toolBlock.includes("bili_feed"), "缺 bili_feed");
  assert.ok(toolBlock.includes("bili_debrief"), "缺 bili_debrief");
  assert.ok(toolBlock.includes("bili_note"), "缺 bili_note");
});

console.log("\n[7] 分享内包在 wakeOnce 里（手动调也分享）");
await ta("未配 ownerMid → share.sent=false 且说明原因", async () => {
  const d = mkDir();
  const sdk = fakeSdk((round) => {
    if (round === 1) return [{ type: "tool-call", id: "c1", name: "bili_note", arguments: { summary: "一条判断", kind: "video", source: "BVzzzzzzzzzz" } }];
    return [{ type: "text-delta", delta: "ok" }];
  });
  const r = await wake.wakeOnce(sdk, d, { wakeMode: "brain", skipChance: 0 }, null);
  assert.ok(r.share, "wakeOnce 必须返回 share 字段");
  assert.equal(r.share.sent, false);
  assert.ok(String(r.share.reason).includes("ownerMid"), `reason=${r.share.reason}`);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("配了 ownerMid + 互关 → 真走私信", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  const dmCalls = [];
  const sdk = fakeSdk((round, req) => {
    if (round === 1) return [{ type: "tool-call", id: "c1", name: "bili_note", arguments: { summary: "值得一看", kind: "video", source: "BVyyyyyyyyyy" } }];
    return [{ type: "text-delta", delta: "ok" }];
  });
  sdk.network = {
    async fetch(url) {
      const u = String(url);
      if (u.includes("/x/relation?")) return { json: async () => ({ code: 0, data: { attribute: 6 } }) };
      if (u.includes("/x/web-interface/nav")) return { json: async () => ({ code: 0, data: { mid: 111, uname: "我" } }) };
      if (u.includes("send_msg")) { dmCalls.push(u); return { json: async () => ({ code: 0, data: { msg_key: 9 } }) }; }
      return { json: async () => ({ code: 0, data: {} }) };
    },
  };
  const r = await wake.wakeOnce(sdk, d, {
    wakeMode: "brain", skipChance: 0, ownerMid: "100000001", shareToOwner: true,
  }, null);
  assert.equal(r.share.sent, true, r.share.reason);
  assert.equal(r.share.via, "dm", `via=${r.share.via}`);
  assert.equal(dmCalls.length, 1, "应该真发了私信");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("shareToOwner=false → 不分享", async () => {
  const d = mkDir();
  const sdk = fakeSdk((round) => {
    if (round === 1) return [{ type: "tool-call", id: "c1", name: "bili_note", arguments: { summary: "x", kind: "video", source: "BVxxxxxxxxxx" } }];
    return [{ type: "text-delta", delta: "ok" }];
  });
  const r = await wake.wakeOnce(sdk, d, { wakeMode: "brain", skipChance: 0, shareToOwner: false }, null);
  assert.equal(r.share.sent, false);
  assert.ok(String(r.share.reason).includes("跳过"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[8] bili_wake 工具接线（防「参数没传 / 返回丢了」）");
await ta("bili_wake 传了 ownerMid 且回传 share", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  const i = src.indexOf('name: "bili_wake"');
  assert.ok(i > 0, "找不到 bili_wake 定义");
  // 取到下一个工具定义为止（不写死字符数——之前 2200 太窄，加了配额代码就被截断）
  const next = src.indexOf('name: "bili_', i + 20);
  const block = src.slice(i, next > i ? next : i + 4000);
  assert.ok(block.includes("ownerMid: cfg.ownerMid"), "没传 ownerMid → 私信不知道发给谁");
  assert.ok(block.includes("shareToOwner: cfg.shareToOwner"), "没传 shareToOwner");
  assert.ok(block.includes("share: r.share"), "返回里丢了 share 字段");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
