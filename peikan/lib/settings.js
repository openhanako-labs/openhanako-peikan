/**
 * lib/settings.js — 配置写入（P14 / P17 改成写文件）
 *
 * 之前写宿主 `ctx.config.setMany`，所以必须留着宿主设置入口。
 * 现在写 `<dataDir>/config.json`——App 自己的地盘，
 * 宿主设置列表里那条多余条目可以撤了。
 *
 * 底线不变：**这个模块只负责「把值写进去」，不负责「该不该开」**。
 * 开不开某个能力，是人的判断，不是代码的。
 */

import { readConfig, writeConfig, DEFAULTS } from "./config.js";

/** 允许通过工具修改的键（其余一律拒绝） */
const WRITABLE = new Set([
  // 安全开关
  "autoPostEnabled", "socialEnabled", "publishLive", "allowProactiveComment", "onboardDismissed",
  // 作息与行为
  "wakeMode", "brainFallback", "notifyOnWake", "shareToOwner", "shareMaxPerDay", "digestToOwner",
  "skipChance", "maxVideos", "deepRead", "maxWakesPerDay", "nightWindows",
  // 口味与标尺
  "like", "dislike", "minScore",
  // 白名单与配额
  "scope", "quotaComment", "quotaDynamic", "quotaDm", "quotaLike", "shareDaily", "sameTargetDays",
  // 沉默衰减
  "silentAfterDays", "silentStopDays",
  // 人设与分享
  "personaName", "ownerTitle", "selfClaim", "ownerMid", "shareVia",
  // 监听
  "listenComment", "listenDm",
]);

/** 危险键：改这些属于「让号对外动作」，必须显式点名，且会回显警告 */
const DANGEROUS = new Set(["autoPostEnabled", "socialEnabled", "publishLive"]);

/**
 * 写配置（直接落盘）。
 *
 * @param {object} ctx   App ctx（要 ctx.dataDir）
 * @param {object} patch { key: value }
 * @returns {Promise<{ok:boolean, applied?:object, rejected?:string[], warnings?:string[]}>}
 */
export async function apply(ctx, patch = {}) {
  const dataDir = ctx?.dataDir || "";
  if (!dataDir) return { ok: false, error: "缺 dataDir，无法写配置" };

  const applied = {};
  const rejected = [];
  const warnings = [];

  for (const [k, v] of Object.entries(patch || {})) {
    if (!WRITABLE.has(k)) {
      rejected.push(k);
      continue;
    }
    applied[k] = v;
    if (DANGEROUS.has(k) && v === true) {
      warnings.push(`${k} 被设为 true —— 她会开始对外动作`);
    }
  }

  if (!Object.keys(applied).length) {
    return { ok: false, error: "没有可写的键", rejected };
  }

  try {
    writeConfig(dataDir, applied);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), rejected };
  }

  // 回读确认
  let after = null;
  try { after = await readConfig(ctx); } catch { /* 读不到不回显 */ }

  return {
    ok: true,
    applied,
    rejected,
    warnings,
    now: after ? {
      autoPostEnabled: after.autoPostEnabled,
      socialEnabled: after.socialEnabled,
      publishLive: after.publishLive,
      wakeMode: after.wakeMode,
      scope: after.scope,
    } : null,
  };
}

/** 只读：当前所有可写键的值（给工具回显用） */
export async function snapshot(ctx) {
  const c = await readConfig(ctx);
  const out = {};
  for (const k of WRITABLE) {
    if (c[k] !== undefined) out[k] = c[k];
  }
  return out;
}

export { WRITABLE, DANGEROUS };
