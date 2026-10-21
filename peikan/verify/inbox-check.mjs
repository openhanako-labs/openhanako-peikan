/**
 * verify/inbox-check.mjs — 收件箱与已发验证（纯逻辑，不联网）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const msgfeed = await import(pathToFileURL(path.join(APP, "lib/msgfeed.js")).href);
const mycomments = await import(pathToFileURL(path.join(APP, "lib/mycomments.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

console.log("[1] 正文提取（source_content 优先于 title）");
t("有 source 时用 source", () => {
  const r = msgfeed.bodyOf({ source: "真实回复", title: "不可靠的标题" });
  assert.equal(r, "真实回复");
});
t("无 source 时退回 title", () => {
  const r = msgfeed.bodyOf({ source: "", title: "标题兜底" });
  assert.equal(r, "标题兜底");
});
t("都空时返回空串", () => {
  assert.equal(msgfeed.bodyOf({ source: "", title: "" }), "");
});
t("超长被截断到 300", () => {
  const r = msgfeed.bodyOf({ source: "字".repeat(500) });
  assert.ok(r.length <= 300, `长度 ${r.length}`);
});
t("换行折叠成空格", () => {
  const r = msgfeed.bodyOf({ source: "第一行\n第二行\n第三行" });
  assert.equal(r, "第一行 第二行 第三行");
});

console.log("\n[2] 本地账（audit → 已发列表）");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
t("空账本返回空", () => {
  assert.equal(mycomments.fromAudit(dir).length, 0);
});
t("只取 SENT，忽略 BLOCK/HOLD", () => {
  const lines = [
    { at: "2026-10-20T01:00:00Z", decision: "BLOCK", kind: "comment", reason: "kill switch" },
    { at: "2026-10-20T02:00:00Z", decision: "SENT", kind: "comment", rpid: "111", bvid: "BV1xx" },
    { at: "2026-10-20T03:00:00Z", decision: "DRY_RUN", kind: "comment" },
    { at: "2026-10-20T04:00:00Z", decision: "SENT", kind: "dynamic", dynId: "222" },
  ];
  fs.writeFileSync(path.join(dir, "audit.jsonl"), lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = mycomments.fromAudit(dir);
  assert.equal(r.length, 2, `得到 ${r.length} 条`);
});
t("评论带 url", () => {
  const r = mycomments.fromAudit(dir);
  const c = r.find((x) => x.kind === "comment");
  assert.ok(c.url.includes("BV1xx"), c.url);
  assert.ok(c.url.includes("#reply111"), c.url);
});
t("动态带 url", () => {
  const r = mycomments.fromAudit(dir);
  const d = r.find((x) => x.kind === "dynamic");
  assert.ok(d.url.includes("t.bilibili.com/222"), d.url);
});
t("最新在前", () => {
  const r = mycomments.fromAudit(dir);
  assert.ok(r[0].at > r[1].at, "顺序不是最新在前");
});

console.log("\n[3] 水位（不重复通知）");
t("status 初始为空", () => {
  const s = msgfeed.status(dir);
  assert.equal(s.lastPollAt, null);
});
t("markAllSeen 写入当前时间", () => {
  const r = msgfeed.markAllSeen(dir);
  assert.ok(r.markedAt > 0);
  const s = msgfeed.status(dir);
  assert.ok(s.replySeenAt > 0);
  assert.ok(s.atSeenAt > 0);
});

console.log("\n[4] 无 network 时优雅降级");
const noNet = await (async () => {
  try { return await msgfeed.poll({}, dir, {}); }
  catch (e) { return { ok: false, error: "throw: " + e.message }; }
})();
t("poll 返回 ok:false 而非抛错", () => {
  assert.equal(noNet.ok, false);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
