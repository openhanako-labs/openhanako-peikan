/**
 * lib/config.js — 配置（P17：自持，不再依赖宿主设置）
 *
 * 为什么改：
 *   之前配置走宿主的 `contributes.settings`，于是宿主设置列表里多出一条
 *   「奥菲莉娅 · B站 设置」——那是她自己的偏好，不该挂在公共走廊上。
 *   而且宿主那份 schema 会把 persona 之类私密字段摊在设置页里。
 *
 * 现在的规则：
 *   · 唯一事实源 = `<dataDir>/config.json`（App 自己写、自己读）
 *   · 首次启动时从宿主 `ctx.config.getAll()` 迁移一次（不丢已有配置）
 *   · 宿主入口撤掉（manifest 不再声明 contributes.settings）
 *
 * 迁移是单向的：读一次宿主 → 落盘 → 之后只认文件。
 * 这样即使宿主哪天清了配置，她的偏好也还在。
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  // 行为
  autoPostEnabled: false,   // kill switch：总开关（关 = 只读）
  socialEnabled: false,     // 点对点开关：关注/私信（不影响公开发言）
  publishLive: false,       // 公开发言真发（评论/动态/点赞）
  allowProactiveComment: false,
  onboardDismissed: false,   // 引导是否已被用户关掉（存在 config 里，不靠 localStorage）  // 允许她主动去别人的视频下评论（默认关：这是最外显的动作）
  personaName: "奥菲莉娅",
  ownerTitle: "主人",
  selfClaim: "我",
  ownerMid: "",             // 你的 B站 mid（私信收件人；“谁算主人”的唯一依据）

  // 作息
  nightWindows: "07:00-09:00,12:00-14:00,20:00-23:00",  // 窗口固定、时刻随机
  maxWakesPerDay: 3,        // 每天最多醒几次（硬上限）——只管她自己醒，不管手动叫醒
  maxManualWakesPerDay: 10, // 手动叫醒的防抖上限（不算在作息额度里，只防连点）
  skipChance: 0.3,          // 每次醒来独立掷（只在「自己看一轮」时掷；有人找她的轮次不掷）
  maxVideos: 5,             // 初筛条数
  deepRead: 2,              // 深读条数
  wakeEnabled: false,       // 是否叫醒会话（会花 token，默认关）
  wakeMode: "brain",        // 醒来怎么跑：rule（纯规则，不花钱）/ brain（她自己用模型想）
  brainFallback: true,      // brain 失败或无产出时，是否退回规则兜底
  notifyOnWake: true,       // 醒来看完后要不要发系统通知（只推值得的）
  shareToOwner: true,       // 醒来看完递一条视频给你（带 BV 链接）
  shareMaxPerDay: 10,       // 【已废弃 2026-10-22】分享上限以 quota.shareDaily 为唯一真相；保留仅为旧配置兼容
  digestToOwner: true,      // 每天 22:00 推一次「今天谁找过她」
  // 偏好（接 browse 的过滤与加权）
  like: "AI 工具与插件,鬼畜与怀旧向剪辑,猫咪,Live2D/模型,游戏实况",
  dislike: "带货,擦边,标题党,纯搬运",

  // 标尺
  minScore: 13,             // 5 项各 0-4，满分 20，≥13 才发

  // 配额与白名单
  scope: "reply-to-me",     // 发言白名单：逗号分隔；reply-to-me = 任何找过她的人
  quotaComment: 2,
  quotaDynamic: 1,
  quotaDm: 3,
  quotaLike: 5,             // 点赞/天（最轻的对外动作，但也不能无限）
  shareDaily: 3,
  sameTargetDays: 7,        // 同一目标 N 天内一次（分享型）

  // 沉默衰减
  silentAfterDays: 3,
  silentStopDays: 7,

  // 分享方式
  shareVia: "comment",

  // 监听
  listenComment: true,
  listenDm: true,
};

const KEYS = Object.keys(DEFAULTS);
const FILE = "config.json";

const listOf = (v) => String(v ?? "").split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
const numOf = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** 配置文件路径 */
export function configPath(dataDir) {
  return path.join(dataDir || "", FILE);
}

/** 读盘上那份（不含默认值合并）。坏文件当空对象，不炸。 */
function readFile(dataDir) {
  if (!dataDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(configPath(dataDir), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** 写盘（合并式：只覆盖给出的键） */
export function writeConfig(dataDir, patch = {}) {
  if (!dataDir) throw new Error("缺 dataDir");
  const cur = readFile(dataDir) || {};
  const next = { ...cur, ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath(dataDir), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * 首次迁移：从宿主 ctx.config 搬到文件。
 * 只在「文件不存在」时做一次，之后不再读宿主——避免两边打架。
 */
async function migrateOnce(ctx, dataDir) {
  if (!dataDir) return null;
  if (fs.existsSync(configPath(dataDir))) return null;   // 已经搬过

  const out = {};
  const api = ctx?.config;
  try {
    if (api && typeof api.getAll === "function") {
      const all = await api.getAll.call(api);
      if (all && typeof all === "object") {
        for (const k of KEYS) if (all[k] !== undefined && all[k] !== null) out[k] = all[k];
      }
    } else if (api && typeof api.get === "function") {
      for (const k of KEYS) {
        try {
          const v = await api.get.call(api, k);
          if (v !== undefined && v !== null) out[k] = v;
        } catch { /* 单键失败跳过 */ }
      }
    }
  } catch { /* 宿主没给就空着，用默认 */ }

  // 迁移结果落盘（哪怕空也要写，标记「已迁移」，下次不再问宿主）
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath(dataDir), JSON.stringify(out, null, 2) + "\n");
  } catch { /* 写不了就每次读宿主兜底 */ }

  return out;
}

/**
 * 读配置并做类型归一。
 * 优先 dataDir/config.json；没有就迁移一次；再没有就默认值。
 */
export async function readConfig(ctx) {
  const dataDir = ctx?.dataDir || "";

  let stored = readFile(dataDir);
  if (stored === null) {
    stored = (await migrateOnce(ctx, dataDir)) || {};
  }

  const raw = { ...DEFAULTS };
  for (const k of KEYS) {
    if (stored[k] !== undefined && stored[k] !== null) raw[k] = stored[k];
  }

  return {
    ...raw,
    autoPostEnabled: raw.autoPostEnabled === true,
    socialEnabled: raw.socialEnabled === true,
    publishLive: raw.publishLive === true,
    allowProactiveComment: raw.allowProactiveComment === true,
    onboardDismissed: raw.onboardDismissed === true,
    wakeEnabled: raw.wakeEnabled === true,
    wakeMode: raw.wakeMode === "brain" ? "brain" : "rule",
    brainFallback: raw.brainFallback !== false,
    notifyOnWake: raw.notifyOnWake !== false,
    shareToOwner: raw.shareToOwner !== false,
    shareMaxPerDay: numOf(raw.shareMaxPerDay, 10),
    digestToOwner: raw.digestToOwner !== false,
    quotaLike: numOf(raw.quotaLike, 5),
    listenComment: raw.listenComment !== false,
    listenDm: raw.listenDm !== false,

    like: listOf(raw.like),
    dislike: listOf(raw.dislike),
    scope: listOf(raw.scope),

    maxWakesPerDay: numOf(raw.maxWakesPerDay, 3),
    maxManualWakesPerDay: numOf(raw.maxManualWakesPerDay, 10),
    skipChance: numOf(raw.skipChance, 0.3),
    maxVideos: numOf(raw.maxVideos, 5),
    deepRead: numOf(raw.deepRead, 2),
    minScore: numOf(raw.minScore, 13),

    quota: {
      comment: numOf(raw.quotaComment, 2),
      dynamic: numOf(raw.quotaDynamic, 1),
      dm: numOf(raw.quotaDm, 3),
      like: numOf(raw.quotaLike, 5),
      shareDaily: numOf(raw.shareDaily, 3),
      sameTargetDays: numOf(raw.sameTargetDays, 7),
    },
    silentAfterDays: numOf(raw.silentAfterDays, 3),
    silentStopDays: numOf(raw.silentStopDays, 7),
  };
}

export { KEYS };
