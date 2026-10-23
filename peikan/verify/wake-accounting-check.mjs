/**
 * verify/wake-accounting-check.mjs — 两种唤醒分开记账（2026-10-23）
 *
 * 由来：手动叫醒和生物钟写进同一个计数器，于是日志/界面上出现过 4/3、5/3、6/3，
 * 一路爬到 12/3。数字本身不是 bug，但它把两个问题混成了一团：
 *   · 她今天自己醒了几次（作息有没有节制）
 *   · 今天被叫了几次（人急不急）
 *
 * 现在的记法：
 *   wakes        —— 生物钟唤醒，受 maxWakesPerDay 管
 *   manualWakes —— 手动叫醒，不占作息额度，只受防抖上限（maxManualWakesPerDay）管
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

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "acct-"));
const cfg = { nightWindows: "07:00-09:00,12:00-14:00,20:00-23:00", maxWakesPerDay: 3, skipChance: 0 };

console.log("[1] 手动叫醒不占作息额度");
t("markManualWake 只涨 manualWakes，不动 wakes", () => {
  const d = mkDir();
  try {
    rhythm.markManualWake(d);
    rhythm.markManualWake(d);
    const st = rhythm.status(d);
    assert.equal(st.wakes, 0, `作息次数被手动带跑了：${st.wakes}`);
    assert.equal(st.manualWakes, 2, `手动次数应为 2，实际 ${st.manualWakes}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
t("手动叫醒不改计划（作息不该因为它改钟）", () => {
  const d = mkDir();
  try {
    rhythm.planAndSave(d, cfg);
    const before = JSON.stringify(rhythm.status(d).plan);
    rhythm.markManualWake(d);
    assert.equal(JSON.stringify(rhythm.status(d).plan), before, "手动叫醒后计划被改了");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[2] 作息额度只被生物钟消耗");
t("markWoke 只涨 wakes，不动 manualWakes", () => {
  const d = mkDir();
  try {
    rhythm.markManualWake(d);
    rhythm.markWoke(d, cfg);
    const st = rhythm.status(d);
    assert.equal(st.wakes, 1, `作息次数应为 1，实际 ${st.wakes}`);
    assert.equal(st.manualWakes, 1, `手动次数被生物钟带跑了：${st.manualWakes}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
t("budget 按作息算，不把手动算进去", () => {
  const d = mkDir();
  try {
    for (let i = 0; i < 5; i++) rhythm.markManualWake(d);
    const b = rhythm.budget(d, cfg);
    assert.equal(b.cap, 3);
    assert.equal(b.wakes, 0, `手动叫醒把作息额度吃掉了：${b.wakes}`);
    assert.equal(b.left, 3);
    assert.equal(b.manualWakes, 5);
    assert.equal(b.exhausted, false, "手动叫了 5 次不该判定作息用完");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log("\n[3] 数字不会再出现 4/3");
t("手动叫 6 次后，作息仍是 0/3", () => {
  const d = mkDir();
  try {
    for (let i = 0; i < 6; i++) rhythm.markManualWake(d);
    const st = rhythm.status(d);
    assert.ok(st.wakes <= 3, `作息次数越界：${st.wakes}`);
    assert.equal(st.wakes, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
