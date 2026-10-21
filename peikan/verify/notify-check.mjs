/**
 * verify/notify-check.mjs — 通知逻辑验证（不真弹）
 *
 * 验证「只推值得的」这套判断，用假 sdk 记录调用。
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const notify = await import(pathToFileURL(path.join(APP, "lib/notify.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function fakeSdk() {
  const calls = [];
  return {
    calls,
    notifications: {
      async show(input) { calls.push(input); return { shown: true }; },
    },
  };
}

console.log("[1] 什么时候不推");
await ta("掷到不想看 → 不推", async () => {
  const sdk = fakeSdk();
  const r = await notify.afterWake(sdk, "/tmp", { ok: true, skipped: true });
  assert.equal(r.pushed, false);
  assert.equal(sdk.calls.length, 0);
});
await ta("看了但没到标尺 → 不推", async () => {
  const sdk = fakeSdk();
  const r = await notify.afterWake(sdk, "/tmp", { ok: true, skipped: false, deepRead: 2, best: null });
  assert.equal(r.pushed, false);
  assert.equal(sdk.calls.length, 0);
  assert.ok(r.reason.includes("不推通知"), r.reason);
});
await ta("看完了也不推（分享走私信）", async () => {
  const sdk = fakeSdk();
  const r = await notify.afterWake(sdk, "/tmp", {
    ok: true, skipped: false, deepRead: 2,
    best: { title: "测试视频标题", total: 15, parts: { density: 4, novelty: 4 } },
  });
  assert.equal(r.pushed, false, "看完不该发系统通知");
  assert.equal(sdk.calls.length, 0, "不该调 notifications.show");
  assert.ok(r.reason.includes("私信"), r.reason);
});

console.log("\n[2] 什么时候推");
await ta("只有出错才推", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nt-"));
  const sdk = fakeSdk();
  const r = await notify.afterWake(sdk, d, { ok: false, error: "登录失效" });
  assert.equal(r.pushed, true);
  assert.equal(sdk.calls.length, 1);
  assert.ok(sdk.calls[0].body.includes("登录失效"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("同一天不重复报错", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nt-"));
  const sdk = fakeSdk();
  await notify.afterWake(sdk, d, { ok: false, error: "第一次" });
  const sdk2 = fakeSdk();
  const r2 = await notify.afterWake(sdk2, d, { ok: false, error: "第二次" });
  assert.equal(r2.pushed, false);
  assert.equal(sdk2.calls.length, 0, "一天只报一次");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 失败降级");
await ta("没有 notifications 能力 → 静默降级", async () => {
  const r = await notify.push({}, "/tmp", { title: "t", body: "b" });
  assert.equal(r.ok, false);
  assert.ok(r.skipped.includes("notifications"));
});
await ta("通知抛错不会炸", async () => {
  const sdk = { notifications: { async show() { throw new Error("boom"); } } };
  const r = await notify.push(sdk, "/tmp", { title: "t", body: "b" });
  assert.equal(r.ok, false);
  assert.ok(r.skipped.includes("boom"));
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
