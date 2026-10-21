/**
 * verify/p4-check.mjs — P4 对齐原仓库五项验证
 *
 *   1. fail-closed（账本坏了拒绝发言）
 *   2. 白名单 scope
 *   3. 本地日期（UTC ISO 不能直接比）
 *   4. 沉默衰减曲线
 *   5. 标尺 + 偏好
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const quota = await import(pathToFileURL(path.join(APP, "lib/quota.js")).href);
const silence = await import(pathToFileURL(path.join(APP, "lib/silence.js")).href);
const score = await import(pathToFileURL(path.join(APP, "lib/score.js")).href);
const browse = await import(pathToFileURL(path.join(APP, "lib/browse.js")).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ophelia-p4-"));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

// ── 1. fail-closed ───────────────────────────────────────────────────
console.log("\n[1] 配额 fail-closed");
const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "p4-fc-"));
t("全新安装（无文件）→ 可发", () => {
  const r = quota.check(d1, { type: "comment", target: "BV1", config: { scope: ["BV1"], quota: { comment: 2 } } });
  assert.equal(r.ok, true, r.reason);
});
t("账本损坏 → 拒绝（fail-closed）", () => {
  fs.writeFileSync(path.join(d1, "quota.json"), "{ 坏掉的 JSON ");
  const r = quota.check(d1, { type: "comment", target: "BV1", config: { scope: ["BV1"], quota: { comment: 2 } } });
  assert.equal(r.ok, false);
  assert.equal(r.corrupt, true);
});
t("损坏时 status 明确报告 corrupt", () => {
  const s = quota.status(d1, {});
  assert.equal(s.corrupt, true);
});

// ── 2. 白名单 ───────────────────────────────────────────────────────
console.log("\n[2] 白名单 scope");
const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "p4-wl-"));
const cfgWL = { scope: ["BV1abc", "uid:123"], quota: { comment: 5 } };
t("空白名单 → 谁都不发", () => {
  const r = quota.check(d2, { type: "comment", target: "BV1abc", config: { scope: [], quota: { comment: 5 } } });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("白名单为空"));
});
t("白名单内 → 放行", () => {
  const r = quota.check(d2, { type: "comment", target: "BV1abc", config: cfgWL });
  assert.equal(r.ok, true, r.reason);
});
t("白名单外 → 拦", () => {
  const r = quota.check(d2, { type: "comment", target: "BV9zzz", config: cfgWL });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("不在白名单"));
});
t("uid: 前缀匹配", () => {
  const r = quota.check(d2, { type: "comment", target: "uid:123", config: cfgWL });
  assert.equal(r.ok, true, r.reason);
});

// ── 3. UTC → 本地日期 ───────────────────────────────────────────────
console.log("\n[3] 本地日期（UTC 账本）");
const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "p4-tz-"));
t("凌晨发的不会算成昨天", () => {
  // 构造一条「本地今天 00:30」的记录，存成 UTC ISO
  const localMidnight = new Date();
  localMidnight.setHours(0, 30, 0, 0);
  const iso = localMidnight.toISOString();  // 这是 UTC 表示
  fs.writeFileSync(path.join(d3, "quota.json"), JSON.stringify({ log: [{ at: iso, type: "comment", target: "BVx" }] }));
  const s = quota.status(d3, { quota: { comment: 5 } });
  assert.equal(s.caps.comment.used, 1, "凌晨的记录应算今天");
});

// ── 4. 沉默衰减 ─────────────────────────────────────────────────────
console.log("\n[4] 沉默衰减曲线");
const d4 = fs.mkdtempSync(path.join(os.tmpdir(), "p4-sl-"));
t("从未反馈 → 满额度、不算沉默", () => {
  const s = silence.silenceState(d4, { shareDaily: 3, silentAfterDays: 3, silentStopDays: 7 });
  assert.equal(s.cap, 3);
  assert.equal(s.days, 0);
});
function withDays(n) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "p4-sd-"));
  const last = new Date(Date.now() - n * 86400000).toISOString();
  fs.writeFileSync(path.join(d, "feedback.json"), JSON.stringify({ last, events: [] }));
  return silence.silenceState(d, { shareDaily: 3, silentAfterDays: 3, silentStopDays: 7 });
}
t("day2 → 满 3", () => assert.equal(withDays(2).cap, 3));
t("day3 → 不降（还没到 after）", () => assert.equal(withDays(3).cap, 3));
t("day4 → 2", () => assert.equal(withDays(4).cap, 2));
t("day5 → 1", () => assert.equal(withDays(5).cap, 1));
t("day6 → 1", () => assert.equal(withDays(6).cap, 1));
t("day7 → 0（停发）", () => assert.equal(withDays(7).cap, 0));
t("day10 → 0", () => assert.equal(withDays(10).cap, 0));
t("markFeedback 重置", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "p4-mk-"));
  silence.markFeedback(d, "回了评论");
  const s = silence.silenceState(d, { shareDaily: 3 });
  assert.equal(s.cap, 3);
});

// ── 5. 标尺 + 偏好 ──────────────────────────────────────────────────
console.log("\n[5] 标尺与偏好");
t("偏好命中加分", () => {
  const good = score.preferenceScore("AI 工具 猫咪", ["AI 工具与插件", "猫咪"], []);
  const none = score.preferenceScore("随便什么", ["AI 工具与插件", "猫咪"], []);
  assert.ok(good > none, `命中 ${good} 应大于未命中 ${none}`);
});
t("dislike 命中归零", () => {
  const s = score.preferenceScore("这是带货", [], ["带货"]);
  assert.equal(s, 0);
});
t("标题党扣分", () => {
  const clean = score.qualityScore({ title: "普通标题", desc: "正常描述" });
  const clickbait = score.qualityScore({ title: "震惊！不看后悔", desc: "" });
  assert.ok(clean > clickbait, `正常 ${clean} 应大于标题党 ${clickbait}`);
});
t("评分卡满分 20", () => {
  const card = score.scoreCard({ bvid: "BV1", title: "测试", desc: "x".repeat(100), tags: ["a","b","c"], duration: 600, pubdate: Date.now()/1000, danmaku: 800 }, [], { like: [], dislike: [], minScore: 13 });
  assert.ok(card.total >= 0 && card.total <= 20, `得分 ${card.total} 越界`);
  assert.ok(card.parts && typeof card.parts.density === "number");
});
t("低于阈值 → pass=false", () => {
  const card = score.scoreCard({ bvid: "BV2", title: "", desc: "", tags: [], duration: 0, pubdate: 0, danmaku: 0 }, [], { minScore: 13 });
  assert.equal(card.pass, false);
});
t("偏好过滤剔除 dislike", () => {
  const items = [
    { bvid: "A", title: "猫咪日常" },
    { bvid: "B", title: "带货直播" },
  ];
  const out = browse.applyPreferences(items, { like: ["猫咪"], dislike: ["带货"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].bvid, "A");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
for (const d of [d1, d2, d3, d4]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
process.exit(fail ? 1 : 0);
