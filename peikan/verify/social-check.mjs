/**
 * verify/social-check.mjs — 关注与私信验证（不联网）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const social = await import(pathToFileURL(path.join(APP, "lib/social.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir(cred = true) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "social-"));
  if (cred) {
    fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({
      sessdata: "S", bili_jct: "J", buvid3: "B",
    }));
  }
  return d;
}

/** 假 sdk：可控制 relation 返回值 */
function fakeSdk({ attribute = 0, navMid = "111" } = {}) {
  return {
    network: {
      async fetch(url) {
        const u = String(url);
        if (u.includes("/x/relation?")) {
          return { json: async () => ({ code: 0, data: { attribute } }) };
        }
        if (u.includes("/x/web-interface/nav")) {
          return { json: async () => ({ code: 0, data: { mid: Number(navMid), uname: "我" } }) };
        }
        if (u.includes("relation/modify") || u.includes("send_msg")) {
          return { json: async () => ({ code: 0, data: { msg_key: 123 } }) };
        }
        return { json: async () => ({ code: 0, data: {} }) };
      },
    },
  };
}

console.log("[1] 关系判定");
await ta("attribute=6 → 互关", async () => {
  const d = mkDir();
  const r = await social.relation(fakeSdk({ attribute: 6 }), { sessdata: "S", bili_jct: "J" }, "222");
  assert.equal(r.ok, true);
  assert.equal(r.mutual, true);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("attribute=2 → 已关注未回关", async () => {
  const r = await social.relation(fakeSdk({ attribute: 2 }), { sessdata: "S", bili_jct: "J" }, "222");
  assert.equal(r.mutual, false);
  assert.ok(r.note.includes("未回关"));
});
await ta("attribute=0 → 未关注", async () => {
  const r = await social.relation(fakeSdk({ attribute: 0 }), { sessdata: "S", bili_jct: "J" }, "222");
  assert.equal(r.mutual, false);
  assert.ok(r.note.includes("未关注"));
});

console.log("\n[2] 关注");
await ta("预演 → 不真发", async () => {
  const d = mkDir();
  const r = await social.follow(fakeSdk({ attribute: 0 }), d, { mid: "222", live: false });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "dry-run");
  assert.ok(r.preview.url.includes("relation/modify"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("真发 → 返回 after 状态", async () => {
  const d = mkDir();
  const r = await social.follow(fakeSdk({ attribute: 2 }), d, { mid: "222", live: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, "live");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("缺 mid → 拒", async () => {
  const d = mkDir();
  const r = await social.follow(fakeSdk(), d, { live: false });
  assert.equal(r.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 私信硬限制");
await ta("未互关 → blocked（核心）", async () => {
  const d = mkDir();
  const r = await social.sendDm(fakeSdk({ attribute: 2 }), d, { toMid: "222", text: "hi", live: true });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.ok(r.reason.includes("未互关"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("attribute=0 也 blocked", async () => {
  const d = mkDir();
  const r = await social.sendDm(fakeSdk({ attribute: 0 }), d, { toMid: "222", text: "hi", live: true });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("互关 + 预演 → dry-run", async () => {
  const d = mkDir();
  const r = await social.sendDm(fakeSdk({ attribute: 6 }), d, { toMid: "222", text: "hi", live: false });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "dry-run");
  assert.ok(r.preview.url.includes("send_msg"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("互关 + 真发 → 成功", async () => {
  const d = mkDir();
  const r = await social.sendDm(fakeSdk({ attribute: 6 }), d, { toMid: "222", text: "hi", live: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, "live");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("空正文 → 拒", async () => {
  const d = mkDir();
  const r = await social.sendDm(fakeSdk({ attribute: 6 }), d, { toMid: "222", text: "  ", live: true });
  assert.equal(r.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("无凭据 → 拒", async () => {
  const d = mkDir(false);
  const r = await social.sendDm(fakeSdk({ attribute: 6 }), d, { toMid: "222", text: "hi" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("凭据"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3.5] 点对点开关默认关");
await ta("config 默认 socialEnabled=false", async () => {
  const cfg = await import(pathToFileURL(path.join(APP, "lib/config.js")).href);
  assert.equal(cfg.DEFAULTS.socialEnabled, false, "点对点开关应该默认关");
});
await ta("config 默认 publishLive=false", async () => {
  const cfg = await import(pathToFileURL(path.join(APP, "lib/config.js")).href);
  assert.equal(cfg.DEFAULTS.publishLive, false);
});

console.log("\n[4] 审计记录");
await ta("真发后落审计", async () => {
  const d = mkDir();
  await social.sendDm(fakeSdk({ attribute: 6 }), d, { toMid: "222", text: "hi", live: true });
  const audit = fs.readFileSync(path.join(d, "audit.jsonl"), "utf8");
  assert.ok(audit.includes('"SENT"'), audit);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("预演也落审计（DRY_RUN）", async () => {
  const d = mkDir();
  await social.sendDm(fakeSdk({ attribute: 6 }), d, { toMid: "222", text: "hi", live: false });
  const audit = fs.readFileSync(path.join(d, "audit.jsonl"), "utf8");
  assert.ok(audit.includes("DRY_RUN"), audit);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
