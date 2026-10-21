/**
 * verify/mycomments-check.mjs — 「她做过什么」的动作类型归类
 *
 * 背景（2026-10-20 真机）：审计里 like / dm / follow 没有 kind 字段，
 * 旧代码一律默认 "comment"，于是「点赞」被显示成「评论」。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const my = await import(pathToFileURL(path.join(APP, "lib/mycomments.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "myc-"));
const writeAudit = (d, rows) =>
  fs.writeFileSync(path.join(d, "audit.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

console.log("[1] 审计 → 动作类型映射");
await ta("like 不该被标成 comment", async () => {
  const d = mkDir();
  writeAudit(d, [{ at: "2026-10-20T04:49:40Z", action: "like", decision: "SENT", bvid: "BV1x" }]);
  const list = my.fromAudit(d, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "like", `得到 kind=${list[0].kind}`);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("dm / follow 各自归类，且收件人 mid 不丢", async () => {
  const d = mkDir();
  writeAudit(d, [
    { at: "2020-01-01T00:00:00.000Z", action: "dm", decision: "SENT", toMid: "100000001" },
    { at: "2026-10-20T03:36:16Z", action: "follow", decision: "SENT", mid: "100000001" },
  ]);
  const list = my.fromAudit(d, 10);
  assert.equal(list[0].kind, "follow", "最新的在前");
  assert.equal(list[1].kind, "dm");
  assert.equal(list[1].mid, "100000001", "收件人 mid 丢了");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("publish 的 kind 照旧（comment / dynamic）", async () => {
  const d = mkDir();
  writeAudit(d, [
    { at: "2026-10-20T01:00:00Z", action: "publish", decision: "SENT", kind: "dynamic", dynId: "123" },
  ]);
  const list = my.fromAudit(d, 10);
  assert.equal(list[0].kind, "dynamic");
  assert.ok(String(list[0].url).includes("t.bilibili.com"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("DRY_RUN 不算发过", async () => {
  const d = mkDir();
  writeAudit(d, [{ at: "2026-10-20T01:00:00Z", action: "publish", decision: "DRY_RUN", kind: "comment" }]);
  assert.equal(my.fromAudit(d, 10).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("BLOCK 也不算", async () => {
  const d = mkDir();
  writeAudit(d, [{ at: "2026-10-20T01:00:00Z", action: "publish", decision: "BLOCK", kind: "comment" }]);
  assert.equal(my.fromAudit(d, 10).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("未知 action 不丢，标成 other", async () => {
  const d = mkDir();
  writeAudit(d, [{ at: "2026-10-20T01:00:00Z", action: "unlike", decision: "SENT", bvid: "BV1x" }]);
  const list = my.fromAudit(d, 10);
  assert.equal(list.length, 1, "未知动作也该记下来");
  assert.equal(list[0].kind, "like", "unlike 归到 like 一类");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("[2] 边界");
await ta("没有 audit.jsonl → 空数组不炸", async () => {
  const d = mkDir();
  assert.deepEqual(my.fromAudit(d, 10), []);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("坏行跳过，好行照读", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "audit.jsonl"),
    "{坏 json\n" + JSON.stringify({ at: "2026-10-20T01:00:00Z", action: "like", decision: "SENT" }) + "\n");
  const list = my.fromAudit(d, 10);
  assert.equal(list.length, 1, "坏行不该让整个文件失效");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("limit 生效，且新的在前", async () => {
  const d = mkDir();
  writeAudit(d, [
    { at: "2026-10-20T01:00:00Z", action: "like", decision: "SENT" },
    { at: "2026-10-20T02:00:00Z", action: "like", decision: "SENT" },
    { at: "2026-10-20T03:00:00Z", action: "like", decision: "SENT" },
  ]);
  const list = my.fromAudit(d, 2);
  assert.equal(list.length, 2);
  assert.equal(list[0].at, "2026-10-20T03:00:00Z", "应该新的在前");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
