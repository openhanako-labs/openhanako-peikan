/**
 * verify/allowlist-check.mjs — 动态白名单验证
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const al = await import(pathToFileURL(path.join(APP, "lib/allowlist.js")).href);
const quota = await import(pathToFileURL(path.join(APP, "lib/quota.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const d = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));

console.log("[1] 静态条目");
t("空名单 → 拒", () => {
  const r = al.allows({ scope: [], target: "BV1x", dataDir: d });
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes("白名单为空"));
});
t("完全相等 → 放行", () => {
  const r = al.allows({ scope: ["BV1x"], target: "BV1x", dataDir: d });
  assert.equal(r.allowed, true);
});
t("uid: 精确匹配", () => {
  const r = al.allows({ scope: ["uid:123"], target: "uid:123", dataDir: d });
  assert.equal(r.allowed, true);
});
t("不在名单 → 拒", () => {
  const r = al.allows({ scope: ["BV1x"], target: "BV9z", dataDir: d });
  assert.equal(r.allowed, false);
});

console.log("\n[2] 动态条目 reply-to-me");
t("没有已知人时 → 拒", () => {
  const r = al.allows({ scope: ["reply-to-me"], target: "uid:555", dataDir: d });
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes("没找过她"));
});
t("记入后 → 放行", () => {
  al.rememberPeople(d, [{ mid: "555", name: "小明" }]);
  const r = al.allows({ scope: ["reply-to-me"], target: "uid:555", dataDir: d });
  assert.equal(r.allowed, true);
  assert.ok(r.reason.includes("小明"));
});
t("非该人 → 仍拒", () => {
  const r = al.allows({ scope: ["reply-to-me"], target: "uid:777", dataDir: d });
  assert.equal(r.allowed, false);
});
t("BV 目标不受 reply-to-me 放行", () => {
  const r = al.allows({ scope: ["reply-to-me"], target: "BV1x", dataDir: d });
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes("只放行 uid"));
});
t("静态 + 动态共存", () => {
  const r1 = al.allows({ scope: ["BV1x", "reply-to-me"], target: "BV1x", dataDir: d });
  const r2 = al.allows({ scope: ["BV1x", "reply-to-me"], target: "uid:555", dataDir: d });
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
});

console.log("\n[3] 名单累积与去重");
t("重复记同一个人不重复入库", () => {
  al.rememberPeople(d, [{ mid: "555", name: "小明" }]);
  al.rememberPeople(d, [{ mid: "555", name: "小明" }]);
  const list = al.readKnown(d);
  assert.equal(list.filter((p) => p.mid === "555").length, 1);
  assert.ok(list.find((p) => p.mid === "555").times >= 2);
});
t("能记多个人", () => {
  al.rememberPeople(d, [{ mid: "888", name: "小红" }]);
  assert.ok(al.readKnown(d).length >= 2);
});

console.log("\n[4] 与 quota.check 集成");
t("reply-to-me 放行已知人", () => {
  const r = quota.check(d, {
    type: "comment", target: "uid:555",
    config: { scope: ["reply-to-me"], quota: { comment: 5 } },
  });
  assert.equal(r.ok, true, r.reason);
});
t("reply-to-me 拒未知人", () => {
  const r = quota.check(d, {
    type: "comment", target: "uid:999",
    config: { scope: ["reply-to-me"], quota: { comment: 5 } },
  });
  assert.equal(r.ok, false);
});

console.log("\n[5] describe / forget");
t("describe 报告动态状态", () => {
  const info = al.describe(["reply-to-me", "BV1x"], d);
  assert.equal(info.dynamic.replyToMe, true);
  assert.ok(info.dynamic.knownPeople >= 2);
  assert.equal(info.scope.length, 2);
});
t("forget 清空名单", () => {
  al.forgetPeople(d);
  assert.equal(al.readKnown(d).length, 0);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
fs.rmSync(d, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
