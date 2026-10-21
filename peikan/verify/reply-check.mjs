/**
 * verify/reply-check.mjs — C 档：她自己回话，闸门把关
 *
 * 这是最需要测的一块：她决定说什么，代码决定发不发。
 * 两者之间不许有模糊地带。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const reply = await import(pathToFileURL(path.join(APP, "lib/reply.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "reply-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({
    sessdata: "S", bili_jct: "J", buvid3: "B",
  }));
  return d;
}

const OPEN = {
  autoPostEnabled: true,
  publishLive: true,
  scope: ["reply-to-me", "uid:100000001"],
};

const ITEM = {
  id: "1001",
  kind: "reply",
  mid: "100000001",
  who: "测试用户",
  source: "这段说得挺好，但我觉得你漏了一点",
  oid: "100000000002",
  root: "0",
  parent: "0",
};

function fakeSdk({ code = 0 } = {}) {
  const calls = [];
  return {
    calls,
    network: {
      async fetch(url, init) {
        calls.push({ url: String(url), body: init?.body });
        return { json: async () => ({ code, data: { rpid: 999 }, message: code === 0 ? "" : "失败" }) };
      },
    },
  };
}

console.log("[1] 能不能回：确定性规则");
await ta("kill switch 关 → 不回", () => {
  const d = mkDir();
  const r = reply.canReply(d, { ...OPEN, autoPostEnabled: false }, ITEM);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("kill switch"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("白名单空 → 谁都不回", () => {
  const d = mkDir();
  const r = reply.canReply(d, { ...OPEN, scope: [] }, ITEM);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("白名单"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("不在白名单的人 → 不回", () => {
  const d = mkDir();
  const r = reply.canReply(d, { ...OPEN, scope: ["uid:999"] }, ITEM);
  assert.equal(r.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("白名单里的人 → 可以回", () => {
  const d = mkDir();
  const r = reply.canReply(d, OPEN, ITEM);
  assert.equal(r.ok, true, r.reason);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("缺 oid → 不能回", () => {
  const d = mkDir();
  const r = reply.canReply(d, OPEN, { ...ITEM, oid: "" });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("oid"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 她自己决定不回（SKIP 是合法结果）");
await ta("空正文 → SKIP，不发请求", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await reply.replyTo(sdk, d, OPEN, { item: ITEM, text: "   ", live: true });
  assert.equal(r.ok, false);
  assert.equal(r.decision, "SKIP");
  assert.equal(sdk.calls.length, 0, "空正文不该发请求");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("规则不允许 → SKIP", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await reply.replyTo(sdk, d, { ...OPEN, autoPostEnabled: false }, { item: ITEM, text: "你好", live: true });
  assert.equal(r.decision, "SKIP");
  assert.equal(sdk.calls.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 闸门：敏感内容进待拍板，不发");
await ta("含敏感话题 → HOLD + 进待拍板", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await reply.replyTo(sdk, d, OPEN, { item: ITEM, text: "你说得对，时政这块确实是这样", live: true });
  assert.equal(r.decision, "HOLD", `得到 ${r.decision}：${r.reason}`);
  assert.equal(sdk.calls.length, 0, "HOLD 不该真发");
  const pend = reply.pending(d, "pending");
  assert.equal(pend.length, 1, "应该进待拍板");
  assert.ok(pend[0].text.includes("时政"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("含手机号 → BLOCK，连待拍板都不进", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await reply.replyTo(sdk, d, OPEN, { item: ITEM, text: "我电话 13800138000", live: true });
  assert.equal(r.decision, "BLOCK");
  assert.equal(sdk.calls.length, 0);
  assert.equal(reply.pending(d, "pending").length, 0, "BLOCK 不该进队列");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 正常回话");
await ta("过了闸门 → 真发，并记账", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ code: 0 });
  const r = await reply.replyTo(sdk, d, OPEN, {
    item: ITEM, text: "你说得对，我确实漏了那层。谢谢指出来。", live: true,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.decision, "REPLY");
  assert.equal(sdk.calls.length >= 1, true, "应该发了请求");
  // 记一笔，防止同一楼反复回
  const all = reply.pending(d, "");
  assert.ok(all.some((x) => x.repliedTo === "1001"), "没记住「回过了」");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("同一条不回第二次", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  await reply.replyTo(sdk, d, OPEN, { item: ITEM, text: "第一次回话内容", live: true });
  const n1 = sdk.calls.length;
  const r2 = await reply.replyTo(sdk, d, OPEN, { item: ITEM, text: "第二次回话内容", live: true });
  assert.equal(r2.decision, "SKIP");
  assert.ok(r2.reason.includes("回过"));
  assert.equal(sdk.calls.length, n1, "不该再发一次");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[5] 配额");
await ta("评论配额用完 → 不回", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const tight = { ...OPEN, quota: { comment: 0 } };
  const r = await reply.replyTo(sdk, d, tight, { item: ITEM, text: "在吗", live: true });
  assert.equal(r.ok, false);
  assert.ok(String(r.decision) === "BLOCK" || String(r.decision) === "SKIP", r.decision);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[6] 待拍板：批准 / 驳回");
await ta("驳回会记原因", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  await reply.replyTo(sdk, d, OPEN, { item: ITEM, text: "时政这块", live: true });
  const p = reply.pending(d, "pending")[0];
  reply.reject(d, p.id, "太硬了，软一点");
  const after = reply.pending(d, "rejected");
  assert.equal(after.length, 1);
  assert.ok(after[0].rejectWhy.includes("太硬"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("批准会真发并改状态", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ code: 0 });
  await reply.replyTo(sdk, d, OPEN, { item: ITEM, text: "时政这块确实", live: true });
  const p = reply.pending(d, "pending")[0];
  const r = await reply.approve(sdk, d, OPEN, p.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(reply.pending(d, "pending").length, 0, "批准后不该还在待拍板");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("批准一条不存在的 → 明确报错", async () => {
  const d = mkDir();
  const r = await reply.approve(fakeSdk(), d, OPEN, "r_nope");
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("找不到"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[7] 边界：她手里有没有发布权");
t("brain 的工具里只有 reply，没有裸 publish", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf("const TOOLS = [");
  const j = src.indexOf("];", i);
  const block = src.slice(i, j);
  assert.ok(block.includes("bili_reply"), "她不能回话");
  assert.ok(block.includes("bili_inbox"), "她看不到谁找她");
  assert.ok(!block.includes("bili_publish"), "不该把裸发布给她");
});
t("reply 内部确实过 gate 和 quota", () => {
  const src = fs.readFileSync(path.join(APP, "lib/reply.js"), "utf8");
  assert.ok(src.includes("gate.evaluate"), "没过内容闸门");
  assert.ok(src.includes("quota.check"), "没过配额");
  assert.ok(src.includes("allowlist.allows"), "没过白名单");
});

console.log("\n[同一人冷却]");

await ta("30 天内不再回同一个人", async () => {
  const d = mkDir();
  const { fs, path } = await import("node:fs").then(async (m) => ({ fs: m.default, path: (await import("node:path")).default }));

  // 造一条「30 天内已经回过他」的记录
  const items = [{
    id: "r_1", at: new Date().toISOString(), repliedTo: "999",
    mid: "888999", who: "别人", text: "x", status: "sent",
    sentAt: Date.now() - 3 * 86400000,   // 3 天前
  }];
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "pending-replies.json"), JSON.stringify({ items }));

  const c = reply.canReply(d, { ...OPEN, ownerMid: "100000001", scope: ["reply-to-me", "uid:100000001", "uid:888999"] }, {
    ...ITEM, id: "2002", mid: "888999", oid: "1",
  });
  assert.equal(c.ok, false, "3 天前回过就不该再回");
  assert.equal(c.cooled, true);
  assert.ok(String(c.reason).includes("30 天内不再回"), c.reason);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("主人豁免（不被频次拦）", async () => {
  const d = mkDir();
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;

  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "pending-replies.json"), JSON.stringify({ items: [{
    id: "r_1", at: new Date().toISOString(), repliedTo: "999",
    mid: "100000001", text: "x", status: "sent", sentAt: Date.now() - 86400000,
  }] }));

  const c = reply.canReply(d, { ...OPEN, ownerMid: "100000001" }, {
    ...ITEM, id: "3003", mid: "100000001", oid: "1",
  });
  assert.equal(c.ok, true, "主人不该被 30 天限制拦住：" + c.reason);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("冷却参数可关（sameSomeoneDays: 0）", async () => {
  const d = mkDir();
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;

  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "pending-replies.json"), JSON.stringify({ items: [{
    id: "r_1", at: new Date().toISOString(), repliedTo: "999",
    mid: "888999", text: "x", status: "sent", sentAt: Date.now() - 86400000,
  }] }));

  const c = reply.canReply(d, { ...OPEN, ownerMid: "100000001", sameSomeoneDays: 0, scope: ["reply-to-me", "uid:100000001", "uid:888999"] }, {
    ...ITEM, id: "4004", mid: "888999", oid: "1",
  });
  assert.equal(c.ok, true, "关掉后应该放行：" + c.reason);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
process.exit(fail ? 1 : 0);
