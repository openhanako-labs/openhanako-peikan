/**
 * lib/notify.js — 通知（P6）
 *
 * 原则（照 whale）：**只推值得的，不推流水账**。
 *   · 「给你的信」有内容（过标尺）→ 推一条，带一句摘要
 *   · 没内容 → 不打扰
 *   · 出错（登录失效等）→ 推一条，但只推一次/天，不刷屏
 *
 * 能力：manifest 需声明 app/notifications.show；未授权时静默降级为「只写文件」。
 */

import fs from "node:fs";
import path from "node:path";

const STATE = "notify-state.json";

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, STATE), "utf8")); }
  catch { return { lastErrorAt: null, lastPushAt: null, count: 0 }; }
}

function writeState(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, STATE), JSON.stringify(st, null, 2) + "\n");
  } catch { /* 状态写失败不影响通知 */ }
}

const today = () => new Date().toLocaleDateString("sv-SE");

/**
 * 发一条系统通知。
 * @returns {Promise<{ok:boolean, skipped?:string}>}
 */
export async function push(sdk, dataDir, { title, body, kind = "info" } = {}) {
  const fn = sdk?.notifications?.show;
  if (typeof fn !== "function") {
    return { ok: false, skipped: "宿主未提供 notifications.show（检查 manifest 能力）" };
  }
  try {
    await fn.call(sdk.notifications, { title: String(title || "奥菲莉娅"), body: String(body || "").slice(0, 300) });
    const st = readState(dataDir);
    writeState(dataDir, { ...st, lastPushAt: new Date().toISOString(), count: Number(st.count || 0) + 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, skipped: `通知失败：${e && e.message ? e.message : e}` };
  }
}

/**
 * 一轮醒来后，决定要不要通知。
 *
 * @param {object} sdk
 * @param {string} dataDir
 * @param {object} run  { ok, skipped, deepRead, best }
 * @returns {Promise<{pushed:boolean, reason:string}>}
 */
export async function afterWake(sdk, dataDir, run = {}) {
  // 1. 没看（掷到不想看）→ 不推。她有权安静
  if (run.skipped) return { pushed: false, reason: "这次没看，不打扰" };

  // 2. 跑失败 → 当天只报一次
  if (!run.ok) {
    const st = readState(dataDir);
    const lastDay = st.lastErrorAt ? new Date(st.lastErrorAt).toLocaleDateString("sv-SE") : null;
    if (lastDay === today()) return { pushed: false, reason: "今天已报过错，不重复" };
    const r = await push(sdk, dataDir, {
      title: "奥菲莉娅 · 出了点问题",
      body: `这一轮没看成：${String(run.error || run.note || "未知原因").slice(0, 120)}`,
      kind: "error",
    });
    writeState(dataDir, { ...readState(dataDir), lastErrorAt: new Date().toISOString() });
    return { pushed: r.ok, reason: "错误提示" };
  }

  // 3. 看完了 → **不再推系统通知**
  //
  // 改（2026-10-20）：分享已改成走 B站 私信（share.js），
  // 再发一条系统通知是重复的，而且你说过「系统通知很没必要」。
  // 系统通知现在只留给第 2 条「真出错」——那是你确实需要知道的。
  return { pushed: false, reason: "看完不推通知（分享走私信）" };
}
