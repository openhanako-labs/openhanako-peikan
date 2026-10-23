/**
 * verify/linkqueue-check.mjs — 他发来的视频排一队（2026-10-23）
 *
 * 由来：他私信里丢两条视频链接，她回了话，但那条视频她一次都没打开。
 * social 回合只回话、content 回合只看推荐流，两条路没有交集。
 *
 * 这个队列只做三件事：记住他发了什么、谁还没看、看过就划掉。
 * 注意：**它不授予任何写权限**——点赞/评论/分享仍各走各的闸门。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const lq = await import(pathToFileURL(path.join(APP, "lib/linkqueue.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, why) => { fail++; console.log(`  ✗ ${n} -> ${why}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lq-"));
const A = "BV1SBpg6iEwo";
const B = "BV1t6nu6bEsf";

console.log("[1] 从一段话里抠链接");
t("抠得出 BV 号", () => {
  const r = lq.extract(`这条你看看 https://www.bilibili.com/video/${A}?share_source=copy`);
  assert.deepEqual(r.bvs, [A]);
});
t("同一段里重复的 BV 只算一次", () => {
  const r = lq.extract(`${A} 和 ${A}`);
  assert.equal(r.bvs.length, 1);
});
t("抠得出 b23 短链", () => {
  const r = lq.extract("看这个 https://b23.tv/AbCdEfG 挺有意思");
  assert.equal(r.shorts.length, 1);
  assert.ok(r.shorts[0].includes("b23.tv/AbCdEfG"));
});
t("没有链接就不返回东西", () => {
  const r = lq.extract("今天天气不错");
  assert.equal(r.bvs.length, 0);
  assert.equal(r.shorts.length, 0);
});
t("bvOf 能从 URL 里取 BV", () => {
  assert.equal(lq.bvOf(`https://www.bilibili.com/video/${A}`), A);
  assert.equal(lq.bvOf("没有"), "");
});

console.log("\n[2] 排队与去重");
t("排进去能读出来", () => {
  const d = mkDir();
  try {
    const r = lq.enqueue(d, { bv: A, from: "主人", mid: "1", note: "看看这个" });
    assert.equal(r.added, true);
    const p = lq.pending(d);
    assert.equal(p.length, 1);
    assert.equal(p[0].bv, A);
    assert.equal(p[0].note, "看看这个");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
t("同一条再发一次不重复排队（只更新他说的话）", () => {
  const d = mkDir();
  try {
    lq.enqueue(d, { bv: A, note: "第一次" });
    const r2 = lq.enqueue(d, { bv: A, note: "第二次" });
    assert.equal(r2.added, false);
    const p = lq.pending(d);
    assert.equal(p.length, 1, `排重失败，队里有 ${p.length} 条`);
    assert.equal(p[0].note, "第二次", "他说的话没更新");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
t("没有 BV 也没有短链 → 不入队", () => {
  const d = mkDir();
  try {
    const r = lq.enqueue(d, { note: "空" });
    assert.equal(r.added, false);
    assert.equal(lq.pending(d).length, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[3] 看过就划掉，看过的再发不重排");
t("markWatched 之后 pending 里没有它", () => {
  const d = mkDir();
  try {
    lq.enqueue(d, { bv: A });
    lq.enqueue(d, { bv: B });
    const r = lq.markWatched(d, A);
    assert.equal(r.ok, true);
    const p = lq.pending(d);
    assert.equal(p.length, 1);
    assert.equal(p[0].bv, B);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
t("已经看过的再发来，不重新排队", () => {
  const d = mkDir();
  try {
    lq.enqueue(d, { bv: A });
    lq.markWatched(d, A);
    const r = lq.enqueue(d, { bv: A });
    assert.equal(r.added, false);
    assert.equal(lq.pending(d).length, 0, "看过的又回到待看队列了");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
t("标记不在队里的 BV 不会凭空造一条", () => {
  const d = mkDir();
  try {
    const r = lq.markWatched(d, "BVxxxxxxxxxx");
    assert.equal(r.ok, false);
    assert.equal(lq.pending(d).length, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[4] 陈年链接会自己过期");
t("31 天前没看过的被清掉", () => {
  const d = mkDir();
  try {
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    fs.writeFileSync(path.join(d, "watch-queue.json"), JSON.stringify({
      updatedAt: old,
      items: [{ bv: A, at: old, note: "" }],
    }));
    assert.equal(lq.pending(d).length, 0, "31 天前的链接还赖在队里");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[5] status 报得清楚");
t("pending / watched 分开计", () => {
  const d = mkDir();
  try {
    lq.enqueue(d, { bv: A });
    lq.enqueue(d, { bv: B });
    lq.markWatched(d, A);
    const s = lq.status(d);
    assert.equal(s.pending, 1);
    assert.equal(s.watched, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[6] 从真实消息结构里收链接（复核拓出来的回归）");
// 私信的条目是 { body }，msgfeed 的评论/@ 条目只有 { source, title }。
// 2026-10-23 第一版只读了 body || text → 评论里的链接永远进不了队。
await ta("私信条目（有 body）能进队", async () => {
  const d = mkDir();
  try {
    const r = await lq.collectFromMessages(d, [
      { id: "1", who: "主人", mid: "42", body: `看这个 ${A}`, kind: "dm" },
    ], { ownerMid: "42" });
    assert.equal(r.queued, 1);
    assert.equal(lq.pending(d)[0].bv, A);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
await ta("评论/@ 条目（只有 source/title）也能进队", async () => {
  const d = mkDir();
  try {
    const r = await lq.collectFromMessages(d, [
      { who: "主人", mid: "42", source: `回复了我的评论 https://www.bilibili.com/video/${B}`, title: "（不是那条回复的正文）", kind: "reply" },
    ], { ownerMid: "42" });
    assert.equal(r.queued, 1, "评论里的链接没进队");
    assert.equal(lq.pending(d)[0].bv, B);
    assert.equal(lq.pending(d)[0].source, "comment");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
await ta("不是主人发的就收（别人的转发不是吩咐）", async () => {
  const d = mkDir();
  try {
    const r = await lq.collectFromMessages(d, [
      { who: "路人", mid: "99", body: `看 ${A}`, kind: "dm" },
    ], { ownerMid: "42" });
    assert.equal(r.queued, 0);
    assert.equal(lq.pending(d).length, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
await ta("短链展开成功 → 存 BV；展开失败 → 保留原链", async () => {
  const d = mkDir();
  try {
    const msgs = [{ who: "主人", mid: "42", body: "https://b23.tv/Okkkkkk", kind: "dm" }];
    const ok1 = await lq.collectFromMessages(d, msgs, {
      ownerMid: "42",
      resolveShort: async () => `https://www.bilibili.com/video/${A}`,
    });
    assert.equal(ok1.queued, 1);
    assert.equal(lq.pending(d)[0].bv, A, "展开后应存 BV");

    const d2 = mkDir();
    try {
      await lq.collectFromMessages(d2, [{ who: "主人", mid: "42", body: "https://b23.tv/Qkkkkkk", kind: "dm" }], {
        ownerMid: "42",
        resolveShort: async () => { throw new Error("网络炸了"); },
      });
      const p = lq.pending(d2);
      assert.equal(p.length, 1, "展不开也应该留着");
      assert.equal(p[0].bv, "", "展不开不该凭空填 BV");
      assert.ok(p[0].url.includes("b23.tv"), "原链丢了");
    } finally { fs.rmSync(d2, { recursive: true, force: true }); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
