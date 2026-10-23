/**
 * verify/skip-day-check.mjs — 「这次不想看」只花一个窗口，不花一整天（2026-10-23）
 *
 * 由来（真机实证）：
 *   10-23 07–09 醒来，跑完一轮（写了日记、点了一个赞），markWoke 之后重算计划；
 *   计划层**又掷了一次** skipChance 且掷中 → plan.action = "skip"；
 *   而 planToTimestamp 对 skip 返回 null → scheduleNext 把下一趟直接排到明天 07:00。
 *   于是当天 12–14、20–23 两个窗口一起作废 —— 一个骰子关掉了一整天。
 *
 * 两处都修了：
 *   1. makePlan 不再掷骰子（计划只决定「几点醒」），看不看在醒来那一刻才掷。
 *   2. skip 只算这个窗口用掉了，当天剩下的窗口照常排。
 *
 * 反向验证过的：把 rollSkip 放回 makePlan，[1] 转红；把 skip 的排程改回明天，[2] 转红。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const rhythm = await import(pathToFileURL(path.join(APP, "lib/rhythm.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, why) => { fail++; console.log(`  ✗ ${n} -> ${why}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };

const today = () => new Date().toLocaleDateString("sv-SE");
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

console.log("[1] 计划层不再掷「看不看」的骰子");
t("skipChance=1 时 makePlan 也不返回 skip", () => {
  const p = rhythm.makePlan(
    { date: today(), wakes: 0, usedCount: {} },
    { nightWindows: "00:00-23:59", maxWakesPerDay: 3, skipChance: 1 }
  );
  assert.notEqual(p.action, "skip", `计划层不该再返回 skip，实际 ${p.action}（${p.reason || ""}）`);
  assert.equal(p.action, "wake", "全天窗口内应能 wake");
});
t("skipChance=1 不再让计划层少排一趟", () => {
  // 旧实现：掷中就返回 skip，usedCount 已 +1，但排不出时间 → 整天作废
  const p = rhythm.makePlan(
    { date: today(), wakes: 0, usedCount: {} },
    { nightWindows: "00:00-23:59", maxWakesPerDay: 3, skipChance: 1 }
  );
  assert.equal(typeof p.at, "number", "计划必须带一个时间点（skip 没有时间点，正是它作废整天的原因）");
});

console.log("\n[2] 醒来一次之后，当天剩下的窗口还在");
t("用掉一个窗口后仍排到同一天的下一个窗口（不是明天）", () => {
  const cur = nowMin();
  if (cur >= 23 * 60) return;   // 深夜跑测试：今天的窗口本来就过完了
  const st = { date: today(), wakes: 1, usedCount: { "07:00–09:00": 1 } };
  const p = rhythm.makePlan(st, {
    nightWindows: "07:00-09:00,12:00-14:00,20:00-23:00",
    maxWakesPerDay: 3,
    skipChance: 0,
  });
  assert.notEqual(p.action, "done", `不该当天就收工（${p.reason || ""}）`);
  const ts = rhythm.planToTimestamp(p);
  assert.ok(ts && ts > 0, "算不出下一趟的时间戳");
  const d = new Date(ts);
  assert.equal(d.toLocaleDateString("sv-SE"), today(), `下一趟排到了 ${d.toLocaleString()} —— 不是今天`);
});

console.log("\n[3] markWoke 只写一条 history（重复条目回归）");
t("每次 markWoke 只追加一条记录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skipday-"));
  try {
    const cfg = { nightWindows: "00:00-23:59", maxWakesPerDay: 3, skipChance: 0 };
    rhythm.markWoke(dir, cfg);
    const n1 = JSON.parse(fs.readFileSync(path.join(dir, "rhythm-state.json"), "utf8")).history.length;
    rhythm.markWoke(dir, cfg);
    const n2 = JSON.parse(fs.readFileSync(path.join(dir, "rhythm-state.json"), "utf8")).history.length;
    assert.equal(n2 - n1, 1, `一次唤醒应只记一条，实际多了 ${n2 - n1} 条`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\n[4] 到上限后不再排今天的趟");
t("wakes 到上限 → done", () => {
  const p = rhythm.makePlan(
    { date: today(), wakes: 3, usedCount: {} },
    { nightWindows: "00:00-23:59", maxWakesPerDay: 3, skipChance: 0 }
  );
  assert.equal(p.action, "done");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
