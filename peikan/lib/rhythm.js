/**
 * lib/rhythm.js — 生物钟（P3.1，照 dsh-bili-whale 语义重做）
 *
 * 三条原则（来自参考实现，不是我的发明）：
 *   1. **窗口固定，时刻随机** —— 每个窗口内随机挑一个时刻。等距 cron 是机器，不是人。
 *   2. **窗口 = 一次醒来的机会，但每天合计 ≤ maxWakesPerDay**（硬上限）。
 *   3. **有权利不看** —— 每次醒来独立掷 skipChance，不是拿日期做种子。
 *
 * 实现：用 `tasks.schedule({ runAt })` 排一次性任务，醒来后由 planNext 重排下一趟。
 * 不用 intervalMs —— 那会变成固定节拍。
 */

import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "rhythm-state.json";

const DEFAULT_WINDOWS = "07:00-09:00,12:00-14:00,20:00-23:00";
const MAX_WAKES_HARD = 3;

const today = () => new Date().toLocaleDateString("sv-SE");
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const parseHHMM = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  const H = h === 24 ? 24 : h;
  return (H === 24 ? 1440 : H * 60) + (m || 0);
};

/** "07:00-09:00,17:00-18:00" → [{ start, end, label }] */
export function parseWindows(str) {
  return String(str || DEFAULT_WINDOWS)
    .split(/[,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/.exec(s);
      if (!m) return null;
      const start = parseHHMM(m[1]);
      const end = parseHHMM(m[2]);
      if (!(end > start)) return null;
      return { start, end, label: `${m[1]}–${m[2]}` };
    })
    .filter(Boolean);
}

function readState(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), "utf8"));
    if (j?.date === today()) return j;
    return { date: today(), wakes: 0, usedCount: {}, plan: null, history: j?.history || [] };
  } catch {
    return { date: today(), wakes: 0, usedCount: {}, plan: null, history: [] };
  }
}

function writeState(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, STATE_FILE), JSON.stringify(st, null, 2) + "\n");
  } catch { /* 状态写失败不影响本轮 */ }
}

/**
 * 掷骰子：今天这一趟看不看。**每次独立**，不是拿日期做种子。
 */
export function rollSkip(skipChance = 0.3) {
  const p = Number(skipChance);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (p >= 1) return true;
  return Math.random() < p;
}

/**
 * 算下一趟计划（纯函数，不落盘不排程）。
 * @returns {{action:"wake"|"skip"|"done", at?:number, atText?:string, window?:string, reason?:string, usedCount:object, wakes:number}}
 */
export function makePlan(state, cfg = {}) {
  const windows = parseWindows(cfg.nightWindows);
  const maxWakes = Math.min(MAX_WAKES_HARD, Math.max(0, Number(cfg.maxWakesPerDay ?? MAX_WAKES_HARD)));

  const st = state?.date === today() ? state : { date: today(), wakes: 0, usedCount: {} };
  const usedCount = { ...(st.usedCount || {}) };
  const wakes = Number(st.wakes || 0);
  const now = nowMin();

  if (!windows.length) {
    return { action: "done", reason: "没有配置任何作息窗口", usedCount, wakes };
  }
  if (maxWakes === 0) {
    return { action: "done", reason: "maxWakesPerDay=0 → 今天不醒", usedCount, wakes };
  }
  if (wakes >= maxWakes) {
    return { action: "done", reason: `今天已经醒了 ${wakes} 次（上限 ${maxWakes}）`, usedCount, wakes };
  }

  // 只挑【正在进行中】的窗口：w.start <= now < w.end
  // ⚠️ 修过：之前只写 w.end > now，会把“还没开始的窗口”也算进去
  //    → 早上醒来却把晚上的额度用掉，并预定今晚再醒（实测 bug，2026-10-20）
  const pool = windows.filter(
    (w) => w.start <= now && now < w.end && (usedCount[w.label] ?? 0) < 1
  );
  if (!pool.length) {
    // 不在任何窗口内（或当前窗口已用完）→ 不是“今天结束”，而是“等到下一个窗口”
    // 找今天还剩的窗口；没有就等到明天第一个
    const upcoming = windows.filter((w) => w.start > now && (usedCount[w.label] ?? 0) < 1);
    if (upcoming.length) {
      const next = upcoming.reduce((a, b) => (a.start <= b.start ? a : b));
      return {
        action: "wait",
        at: next.start,
        atText: hhmm(next.start),
        window: next.label,
        reason: `当前不在窗口内，等 ${next.label} 开始`,
        usedCount, wakes,
      };
    }
    return { action: "done", reason: "今天的窗口都过完了", usedCount, wakes };
  }

  // 随机挑一个窗口（不是按顺序）
  const w = pool[Math.floor(Math.random() * pool.length)];
  usedCount[w.label] = (usedCount[w.label] ?? 0) + 1;

  // 每次独立掷「看不看」
  if (rollSkip(cfg.skipChance)) {
    return {
      action: "skip",
      window: w.label,
      reason: `这次不想看（掷到了那 ${Math.round(Number(cfg.skipChance) * 100)}%）`,
      usedCount,
      wakes,
    };
  }

  // 窗口内随机时刻；窗口已开始则顺延一点点
  let at = w.start + Math.floor(Math.random() * Math.max(1, w.end - w.start));
  if (at <= now) at = Math.min(w.end - 1, now + 1 + Math.floor(Math.random() * 10));

  return {
    action: "wake",
    at,
    atText: hhmm(at),
    window: w.label,
    usedCount,
    wakes,
  };
}

/**
 * 算下一趟并落盘（不排程）。到点由宿主触发 browse.tick。
 */
export function planAndSave(dataDir, cfg = {}) {
  const st = readState(dataDir);
  const plan = makePlan(st, cfg);
  const next = {
    ...st,
    date: today(),
    usedCount: plan.usedCount,
    plan,
    history: [
      ...(st.history || []).slice(-20),
      { at: new Date().toISOString(), action: plan.action, window: plan.window || null, atText: plan.atText || null, reason: plan.reason || null },
    ],
  };
  writeState(dataDir, next);
  return plan;
}

/** 醒来后记一笔（wakes +1），再算下一趟 */
export function markWoke(dataDir, cfg = {}) {
  const st = readState(dataDir);
  const next = {
    ...st,
    date: today(),
    wakes: Number(st.wakes || 0) + 1,
    lastWokeAt: new Date().toISOString(),
  };
  writeState(dataDir, next);
  return planAndSave(dataDir, cfg);
}

/** 读状态（供工具 / 卡片） */
export function status(dataDir) {
  const st = readState(dataDir);
  return {
    date: st.date,
    wakes: st.wakes || 0,
    lastWokeAt: st.lastWokeAt || null,
    plan: st.plan || null,
    recent: (st.history || []).slice(-5).reverse(),
  };
}

/** 把 plan 的 runAt 算成毫秒时间戳（当天）。wake 和 wait 都需要一个可排的时间点。 */
export function planToTimestamp(plan) {
  if (!plan || typeof plan.at !== "number") return null;
  if (plan.action !== "wake" && plan.action !== "wait") return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + plan.at * 60 * 1000;
}

/** 明天第一个窗口开始的毫秒时间戳（今日窗口全过时用） */
export function tomorrowFirstWindowTs(cfg = {}) {
  const windows = parseWindows(cfg.nightWindows);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  const start = windows.length ? Math.min(...windows.map((w) => w.start)) : 7 * 60;
  return d.getTime() + start * 60 * 1000;
}
