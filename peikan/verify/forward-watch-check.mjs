/**
 * verify/forward-watch-check.mjs — 「你发我的，我看了」这条路（2026-10-23）
 *
 * 由来：他把视频发给她，她回了话，视频一次没打开。
 * 修法不是让 social 回合变成浏览回合（那是 P0 刚拆开的），
 * 而是：
 *   · social 回合**只多一只读的手**（bili_debrief），且只在他发过链接时给；
 *   · 而且只能读**队列里那一条**——想顺手刷别的，门关上；
 *   · 赞 / 评论 / 递 / 关注 一个都不给（对外动作仍然归另一轮）。
 *
 * 结构断言（工具表）+ 运行时实证（runTool 真调）各一半。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const wake = await import(pathToFileURL(path.join(APP, "lib/wake.js")).href);
const lq = await import(pathToFileURL(path.join(APP, "lib/linkqueue.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const A = "BV1SBpg6iEwo";
const B = "BV1t6nu6bEsf";
function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fwd-"));
  fs.writeFileSync(path.join(d, "identity.json"), JSON.stringify({ agentId: "a1", agentName: "奥菲莉娅" }));
  fs.writeFileSync(path.join(d, "persona.md"), "你是奥菲莉娅。");
  fs.mkdirSync(path.join(d, "notes"), { recursive: true });
  fs.writeFileSync(path.join(d, "notes", "index.json"), "[]");
  return d;
}
const mkSdk = () => ({ network: { async fetch() { throw new Error("不该触网（被回合门挡住）"); } } });

console.log("[1] 工具表：默认不给，有链接才多一只读的手");
t("social 回合默认没有 bili_debrief", () => {
  const names = wake.toolsForRound("social").map((x) => x.name);
  assert.ok(!names.includes("bili_debrief"), "没人发链接的时候不该能刷视频");
});
t("allowDebrief 时多出 bili_debrief", () => {
  const names = wake.toolsForRound("social", { allowDebrief: true }).map((x) => x.name);
  assert.ok(names.includes("bili_debrief"), "缺 bili_debrief");
});
t("多出来的只有读的手：赞/评/递/关注 仍然不给", () => {
  const names = wake.toolsForRound("social", { allowDebrief: true }).map((x) => x.name);
  for (const n of ["bili_like", "bili_comment", "bili_share", "bili_follow", "bili_feed", "bili_note"]) {
    assert.ok(!names.includes(n), `social 回合不该出现 ${n}`);
  }
});
t("content 回合照旧能深读", () => {
  assert.ok(wake.toolsForRound("content").map((x) => x.name).includes("bili_debrief"));
});

console.log("\n[2] 运行时：social 回合只能读他发来的那条");
await ta("读队列外的 BV → 被挡", async () => {
  const d = mkDir();
  try {
    lq.enqueue(d, { bv: A });
    const runTool = wake.makeToolRunner(mkSdk(), d, { round: "social" });
    const out = await runTool("bili_debrief", { bv: B });
    assert.ok(String(out).includes("只回话"), "读了队列外的视频： " + out);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
await ta("读队列里的 BV → 放行（这里故意让网络失败，看它有没有走到网络层）", async () => {
  const d = mkDir();
  try {
    lq.enqueue(d, { bv: A });
    const runTool = wake.makeToolRunner(mkSdk(), d, { round: "social" });
    const out = await runTool("bili_debrief", { bv: A });
    assert.ok(!String(out).includes("只回话"), "他发来的那条也被挡住了：" + out);
    assert.ok(String(out).length > 0, "没有返回任何东西");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
await ta("深读失败不会被当成看过（队列里还在）", async () => {
  const d = mkDir();
  try {
    lq.enqueue(d, { bv: A });
    const runTool = wake.makeToolRunner(mkSdk(), d, { round: "social" });
    await runTool("bili_debrief", { bv: A });
    assert.equal(lq.pending(d).length, 1, "深读没成功却被划掉了");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[3] content 回合不受这条门限制");
await ta("content 回合能深读任意 BV", async () => {
  const d = mkDir();
  try {
    const runTool = wake.makeToolRunner(mkSdk(), d, { round: "content" });
    const out = await runTool("bili_debrief", { bv: B });
    assert.ok(!String(out).includes("只回话"), "content 回合被回合门误拦：" + out);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
