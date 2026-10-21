/**
 * verify/retract-check.mjs — 收回：只能删自己发过的
 *
 * 一个只能前进不能后退的东西，不叫自主，叫失控。
 * 但反过来，能删别人的更糟。所以本地校验是必须的。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const retract = await import(pathToFileURL(path.join(APP, "lib/retract.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const OPEN = { autoPostEnabled: true };

function mkDir(auditRows = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "retract-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  if (auditRows.length) {
    fs.writeFileSync(path.join(d, "audit.jsonl"), auditRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return d;
}

function fakeSdk({ code = 0 } = {}) {
  const calls = [];
  return {
    calls,
    network: {
      async fetch(url, init) {
        const u = String(url);
        calls.push({ url: u, body: init?.body });
        if (u.includes("/web-interface/view")) {
          return { json: async () => ({ code: 0, data: { aid: 100000000004 } }) };
        }
        return { json: async () => ({ code, data: {}, message: code === 0 ? "" : "失败" }) };
      },
    },
  };
}

const SENT_ROW = {
  at: "2020-01-01T00:00:00.000Z",
  action: "publish",
  decision: "SENT",
  kind: "comment",
  rpid: "100000000001",
  bvid: "BV1xx411c7m1",
};

console.log("[1] 只能删自己发过的");
await ta("审计里没有 → 拦下，不发请求", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await retract.comment(sdk, d, { rpid: "999", bvid: "BV1x", live: true, config: OPEN });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.ok(r.reason.includes("不是她发的"), r.reason);
  assert.equal(sdk.calls.length, 0, "不该发请求");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("审计里有 → 放行", async () => {
  const d = mkDir([SENT_ROW]);
  const sdk = fakeSdk({ code: 0 });
  const r = await retract.comment(sdk, d, { rpid: "100000000001", bvid: "BV1xx411c7m1", live: true, config: OPEN });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, "live");
  assert.ok(sdk.calls.some((c) => c.url.includes("/x/v2/reply/del")));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("DRY_RUN 的记录不算「发过」", async () => {
  const d = mkDir([{ at: "x", action: "publish", decision: "DRY_RUN", kind: "comment", rpid: "100000000001" }]);
  const sdk = fakeSdk();
  const r = await retract.comment(sdk, d, { rpid: "100000000001", live: true, config: OPEN });
  assert.equal(r.blocked, true, "预演没真发，不能删");
  assert.equal(sdk.calls.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] kill switch");
await ta("关着 → 不删", async () => {
  const d = mkDir([SENT_ROW]);
  const sdk = fakeSdk();
  const r = await retract.comment(sdk, d, { rpid: "100000000001", live: true, config: { autoPostEnabled: false } });
  assert.equal(r.blocked, true);
  assert.ok(r.reason.includes("kill switch"));
  assert.equal(sdk.calls.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 预演 vs 真删");
await ta("默认预演：不发删除请求（查 aid 的只读请求不算）", async () => {
  const d = mkDir([SENT_ROW]);
  const sdk = fakeSdk();
  const r = await retract.comment(sdk, d, { rpid: "100000000001", config: OPEN });
  assert.equal(r.mode, "dry-run");
  assert.equal(sdk.calls.filter((c) => c.url.includes("/reply/del")).length, 0, "预演不该真删");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("12022（已删过）不算失败", async () => {
  const d = mkDir([SENT_ROW]);
  const sdk = fakeSdk({ code: 12022 });
  const r = await retract.comment(sdk, d, { rpid: "100000000001", live: true, config: OPEN });
  assert.equal(r.ok, true);
  assert.equal(r.already, true);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("真删会写审计", async () => {
  const d = mkDir([SENT_ROW]);
  const sdk = fakeSdk({ code: 0 });
  await retract.comment(sdk, d, { rpid: "100000000001", live: true, config: OPEN });
  const rows = fs.readFileSync(path.join(d, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.action === "retract" && r.decision === "SENT"), "删除没留痕");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 需要 aid 时会去查");
await ta("没给 oid 但有 bvid → 自动查 aid", async () => {
  const d = mkDir([SENT_ROW]);
  const sdk = fakeSdk({ code: 0 });
  await retract.comment(sdk, d, { rpid: "100000000001", bvid: "BV1xx411c7m1", live: true, config: OPEN });
  assert.ok(sdk.calls.some((c) => c.url.includes("/web-interface/view")), "没查 aid");
  const del = sdk.calls.find((c) => c.url.includes("/reply/del"));
  assert.ok(String(del.body).includes("100000000004"), "aid 没带上");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[5] sentList：还没收回的");
await ta("发过两条、删了一条 → 只剩一条", async () => {
  const d = mkDir([
    { at: "1", action: "publish", decision: "SENT", kind: "comment", rpid: "A", bvid: "BV1" },
    { at: "2", action: "publish", decision: "SENT", kind: "comment", rpid: "B", bvid: "BV2" },
    { at: "3", action: "retract", decision: "SENT", kind: "comment", rpid: "A" },
  ]);
  const list = retract.sentList(d);
  assert.equal(list.length, 1);
  assert.equal(list[0].rpid, "B");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
