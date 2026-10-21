/**
 * lib/silence.js — 沉默衰减（P4，照原仓库语义）
 *
 * 原仓库规则：
 *   沉默 ≥ silentAfterDays(3) 天开始扣，7 天降到 0：
 *   day3=3 → day4=2 → day5=1 → day6=1 → day7+=0
 *   **但两本日记照常写**（那是她的日子，不是发言）
 *
 * 「反馈」的定义很宽：任何表态都算（回她的评论 / 点赞 / 让她做点事）。
 * 都没有 = 沉默。
 *
 * 数据：<dataDir>/feedback.json  { last: ISO, events: [] }
 */

import fs from "node:fs";
import path from "node:path";

const FILE = "feedback.json";

function read(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")); }
  catch { return { last: null, events: [] }; }
}

function write(dataDir, f) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify(f, null, 2) + "\n");
  } catch { /* 记账失败不影响 */ }
}

/** 记一次反馈（任何来自主人的表态） */
export function markFeedback(dataDir, note = "") {
  const f = read(dataDir);
  f.last = new Date().toISOString();
  f.events = [...(f.events || []).slice(-50), { at: f.last, note: String(note).slice(0, 60) }];
  write(dataDir, f);
  return f.last;
}

/**
 * 算当前的分享额度上限。
 * @param {object} cfg { silentAfterDays=3, silentStopDays=7, shareDaily=3 }
 * @returns {{days:number, cap:number, penalty:number, last:string|null}}
 */
export function silenceState(dataDir, cfg = {}) {
  const f = read(dataDir);
  const baseCap = Number(cfg.shareDaily ?? 3);
  const after = Math.max(1, Number(cfg.silentAfterDays ?? 3));
  const stopAt = Math.max(after + 1, Number(cfg.silentStopDays ?? 7));

  if (!f.last) {
    // 从没反馈过：不算沉默（还没开始），给满额度
    return { days: 0, cap: baseCap, penalty: 0, last: null, phase: "未开始" };
  }

  const days = Math.floor((Date.now() - new Date(f.last).getTime()) / 86400000);

  let cap;
  if (days < after) cap = baseCap;
  else if (days >= stopAt) cap = 0;
  else cap = Math.max(1, Math.floor((baseCap * (stopAt - days)) / (stopAt - after)));

  return {
    days,
    cap,
    penalty: baseCap - cap,
    last: f.last,
    phase: days < after ? "正常" : days >= stopAt ? "已沉默（停止分享）" : "衰减中",
  };
}

/**
 * 是否允许分享（结合沉默衰减）。
 * 注意：这只管「分享额度」，**日记不受影响**。
 */
export function canShare(dataDir, cfg = {}) {
  const s = silenceState(dataDir, cfg);
  return { ok: s.cap > 0, cap: s.cap, state: s };
}
