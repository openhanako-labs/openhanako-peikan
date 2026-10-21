import assert from "node:assert";
/**
 * verify/rhythm-check.mjs — 生物钟语义验证（纯逻辑，不联网）
 *
 * 验证三件事：
 *   1. 时刻随机、不是等距
 *   2. skipChance 每次独立掷（同日多次结果不同）
 *   3. 每天醒来次数有硬上限
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const rhythm = await import(pathToFileURL(path.join(APP, "lib/rhythm.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, why) => { fail++; console.log(`  ✗ ${n} -> ${why}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };

console.log("[1] 窗口解析");
t("解析多窗口", () => {
  const w = rhythm.parseWindows("07:00-09:00,12:00-14:00,20:00-23:00");
  if (w.length !== 3) throw new Error(`得到 ${w.length} 个窗口`);
  if (w[0].start !== 420 || w[0].end !== 540) throw new Error("首个窗口时间错");
});

console.log("\n[2] skipChance 每次独立掷骰（不是日期种子）");
t("同配置多次掷，结果不恒等", () => {
  const results = new Set();
  for (let i = 0; i < 60; i++) results.add(rhythm.rollSkip(0.3));
  if (results.size < 2) throw new Error("60 次掷骰子结果全相同 → 还是种子模式");
});
t("skipChance=0 永不跳过", () => {
  for (let i = 0; i < 20; i++) if (rhythm.rollSkip(0)) throw new Error("0 却跳过了");
});
t("skipChance=1 必然跳过", () => {
  for (let i = 0; i < 20; i++) if (!rhythm.rollSkip(1)) throw new Error("1 却没跳过");
});
t("约 30% 命中率（±15%）", () => {
  let skip = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) if (rhythm.rollSkip(0.3)) skip++;
  const rate = skip / N;
  if (Math.abs(rate - 0.3) > 0.15) throw new Error(`实测 ${(rate * 100).toFixed(1)}%`);
});

console.log("\n[3] 每天醒来的次数上限");
t("已醒满上限 → done", () => {
  const st = { date: new Date().toLocaleDateString("sv-SE"), wakes: 3, usedCount: {} };
  const p = rhythm.makePlan(st, { nightWindows: "00:00-24:00", maxWakesPerDay: 3, skipChance: 0 });
  if (p.action !== "done") throw new Error(`得到 ${p.action}`);
});
t("同一窗口只用一次", () => {
  const date = new Date().toLocaleDateString("sv-SE");
  const label = "00:00–24:00";
  const st = { date, wakes: 1, usedCount: { [label]: 1 } };
  const p = rhythm.makePlan(st, { nightWindows: "00:00-24:00", maxWakesPerDay: 3, skipChance: 0 });
  if (p.action !== "done") throw new Error(`窗口已用过却还是 ${p.action}`);
});

console.log("\n[3b] 窗口边界（2026-10-20 实测 bug 回归）");
t("不在窗口内 → 返回 wait，不是 done", () => {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur < 120 || cur > 1300) return; // 边界情况跳过
  const pastStart = cur - 120;
  const pastEnd = cur - 90;
  const futStart = cur + 120;
  const futEnd = Math.min(1439, cur + 180);
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  const winStr = hhmm(pastStart) + "-" + hhmm(pastEnd) + "," + hhmm(futStart) + "-" + hhmm(futEnd);
  const p = rhythm.makePlan(
    { date: new Date().toLocaleDateString("sv-SE"), wakes: 0, usedCount: {} },
    { nightWindows: winStr, maxWakesPerDay: 3, skipChance: 0 }
  );
  assert.equal(p.action, "wait", "应返回 wait，实际 " + p.action + "（" + (p.reason || "") + "）");
  assert.ok(p.at > cur, "wait 的时间点应在未来");
});
t("绝不选还没开始的窗口（核心回归）", () => {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur > 1300) return;
  const fs2 = Math.min(1400, cur + 60);
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  const p = rhythm.makePlan(
    { date: new Date().toLocaleDateString("sv-SE"), wakes: 0, usedCount: {} },
    { nightWindows: hhmm(fs2) + "-23:59", maxWakesPerDay: 3, skipChance: 0 }
  );
  assert.equal(p.action, "wait", "未开始的窗口不能直接 wake，实际 " + p.action);
});
t("在窗口内 → 可以 wake", () => {
  const p = rhythm.makePlan(
    { date: new Date().toLocaleDateString("sv-SE"), wakes: 0, usedCount: {} },
    { nightWindows: "00:00-23:59", maxWakesPerDay: 3, skipChance: 0 }
  );
  assert.equal(p.action, "wake", "全天窗口内应能 wake，实际 " + p.action);
});

console.log("\n[4] 时刻是随机的，不是等距");
t("多次计划的时刻不重复", () => {
  const date = new Date().toLocaleDateString("sv-SE");
  const times = new Set();
  for (let i = 0; i < 30; i++) {
    const p = rhythm.makePlan({ date, wakes: 0, usedCount: {} }, {
      nightWindows: "00:00-24:00", maxWakesPerDay: 3, skipChance: 0,
    });
    if (p.action === "wake") times.add(p.atText);
  }
  if (times.size < 5) throw new Error(`30 次只得到 ${times.size} 个不同时刻 → 像是等距`);
});

console.log("\n[5] planToTimestamp");
t("wake 计划能算出当天时间戳", () => {
  const ts = rhythm.planToTimestamp({ action: "wake", at: 600 });
  if (!ts || ts <= 0) throw new Error("算不出");
  const d = new Date(ts);
  if (d.getHours() !== 10) throw new Error(`得到 ${d.getHours()} 点`);
});
t("非 wake 返回 null", () => {
  if (rhythm.planToTimestamp({ action: "skip" }) !== null) throw new Error("应返回 null");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);

