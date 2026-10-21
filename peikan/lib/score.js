/**
 * lib/score.js — 标尺（P4.1：确定性 + 用字幕）
 *
 * 两个关键修正：
 *   1. **确定性**：之前 emotion 分依赖「取了几条评论」，同样内容取 3 条和 8 条分数不同。
 *      现在固定取**排序后的前 N 条**（按点赞），并且评分只看固定字段，与请求条数无关。
 *   2. **真看了**：有字幕时，信息密度/情绪价值改用字幕正文算，而不是只看简介长度。
 *
 * 5 项各 0-4，满分 20，≥ minScore(默认 13) 才「值得说」。
 * 信息密度 / 偏好交集 / 新颖度 / 情绪价值 / 表达质量
 */

const EMOTION_WORDS = [
  "笑死", "笑哭", "泪目", "破防", "震撼", "治愈", "绝了", "太强", "牛逼", "卧槽",
  "神作", "封神", "炸裂", "好哭", "感动", "逆天", "离谱", "太好听", "经典",
];

const LOW_QUALITY = [
  "震惊", "不看后悔", "99%的人", "点击领取", "免费送", "私信我", "加微信",
  "带货", "擦边", "搬运",
];

/** 固定取前 N 条热评参与评分（与请求条数解耦） */
const FIXED_COMMENT_N = 5;

/** 稳定排序：按点赞降序、rpid 升序，保证同样输入得同样结果 */
export function stableComments(comments = []) {
  return comments
    .slice()
    .sort((a, b) => (Number(b.like) || 0) - (Number(a.like) || 0) || String(a.rpid || "").localeCompare(String(b.rpid || "")))
    .slice(0, FIXED_COMMENT_N);
}

/** 偏好交集：like 命中加分，dislike 命中扣分 */
export function preferenceScore(text, like = [], dislike = []) {
  const t = String(text || "");
  let hit = 0, bad = 0;
  for (const k of like) if (k && t.includes(k)) hit++;
  for (const k of dislike) if (k && t.includes(k)) bad++;
  if (bad > 0 && hit === 0) return 0;
  return Math.max(0, Math.min(4, Math.round(Math.min(4, hit * 1.5) - bad * 1.5)));
}

/**
 * 信息密度：优先用字幕（真内容），没字幕才退回简介长度 + 标签。
 * @returns {number} 0-4
 */
export function densityScore(video, subtitleText = "") {
  const subLen = String(subtitleText || "").length;
  let s = 0;
  if (subLen > 0) {
    // 有字幕：按实义字数（去空白）
    if (subLen >= 800) s += 3;
    else if (subLen >= 300) s += 2.2;
    else if (subLen >= 100) s += 1.4;
    else s += 0.8;
  } else {
    // 没字幕：只能用简介
    const descLen = String(video?.desc || "").length;
    if (descLen > 250) s += 1.6;
    else if (descLen > 80) s += 1.1;
    else if (descLen > 20) s += 0.6;
  }
  const tagLen = (video?.tags || []).length;
  if (tagLen >= 3) s += 0.8;
  else if (tagLen >= 1) s += 0.4;
  const dur = Number(video?.duration || 0);
  if (dur >= 180 && dur <= 2400) s += 0.6;
  else if (dur > 0) s += 0.2;
  return Math.max(0, Math.min(4, Math.round(s)));
}

/** 新颖度：没看过 + 发布不久 */
export function noveltyScore(video, seenBvids = new Set()) {
  let s = 0;
  if (!seenBvids.has(video?.bvid)) s += 2;
  const ageDays = video?.pubdate ? (Date.now() / 1000 - video.pubdate) / 86400 : 999;
  if (ageDays <= 7) s += 2;
  else if (ageDays <= 30) s += 1.2;
  else if (ageDays <= 180) s += 0.6;
  return Math.max(0, Math.min(4, Math.round(s)));
}

/**
 * 情绪价值：标题 + 字幕 + **弹幕热区密度**。
 * 弹幕比播放数真实：播放可以刷，弹幕是有人真在看某个时刻。
 * @param {object} opts { danmakuBoost: 0-1.5 }
 */
export function emotionScore(text, danmaku = 0, opts = {}) {
  const t = String(text || "");
  let hits = 0;
  for (const w of EMOTION_WORDS) if (t.includes(w)) hits++;
  let s = Math.min(3, hits * 1.1);
  const d = Number(danmaku) || 0;
  if (d > 1000) s += 1;
  else if (d > 300) s += 0.7;
  else if (d > 50) s += 0.4;
  // 弹幕热区：有真实爆发点（峰值远高于均值）额外加
  s += Number(opts.danmakuBoost) || 0;
  return Math.max(0, Math.min(4, Math.round(s)));
}

/** 表达质量：标题清爽度（标题党扣分） */
export function qualityScore(video) {
  const t = String(video?.title || "") + String(video?.desc || "");
  let bad = 0;
  for (const w of LOW_QUALITY) if (t.includes(w)) bad++;
  const titleLen = String(video?.title || "").length;
  let s = 3;
  if (titleLen > 8 && titleLen < 60) s += 0.8;
  s -= bad * 2;
  return Math.max(0, Math.min(4, Math.round(s)));
}

/**
 * 完整评分卡（确定性）。
 * @param {object} video
 * @param {Array} comments  任意条数；内部固定取前 5 条稳定排序（不参与算分）
 * @param {object} cfg { like, dislike, seenBvids, minScore }
 * @param {string} subtitleText  字幕正文（有则参与评分）
 * @param {object} danmakuInfo  { total, hotMoments } —— 热区参与情绪分
 */
export function scoreCard(video, comments = [], cfg = {}, subtitleText = "", danmakuInfo = null) {
  const like = cfg.like || [];
  const dislike = cfg.dislike || [];
  const seen = cfg.seenBvids instanceof Set ? cfg.seenBvids : new Set();
  const threshold = Number(cfg.minScore ?? 13);

  const fixed = stableComments(comments);
  const sub = String(subtitleText || "").slice(0, 4000);

  // ⚠️ 评分**完全不用评论**：评论条数会变，带进去分数就会飘（已验证过的坑）。
  //    fixed 仍保留在返回值里供展示，不参与算分。

  // 偏好：**只看标题 + 简介 + 字幕**，不看评论
  // （评论条数会变，带着它会让同一视频在不同时刻分数不同）
  const prefText = `${video?.title || ""} ${video?.desc || ""} ${sub.slice(0, 1200)}`;
  // 情绪：同样只看内容本身
  const emoText = `${video?.title || ""} ${sub.slice(0, 2000)}`;

  const parts = {
    density: densityScore(video, sub),
    preference: preferenceScore(prefText, like, dislike),
    novelty: noveltyScore(video, seen),
    emotion: emotionScore(emoText, video?.danmaku, { danmakuBoost: danmakuBoostOf(danmakuInfo) }),
    quality: qualityScore(video),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    total,
    parts,
    pass: total >= threshold,
    threshold,
    hasSubtitle: sub.length > 0,
    hasDanmakuHot: Boolean(danmakuInfo?.hotMoments?.length),
    commentSample: fixed.length,
  };
}

/**
 * 弹幕热区加成：峰值密度相对均值越集中，说明越有“炸点”。
 * 确定性：只依赖弹幕条数与峰值，不依赖请求参数。
 */
export function danmakuBoostOf(info) {
  if (!info || !Array.isArray(info.hotMoments) || !info.hotMoments.length) return 0;
  const peak = Math.max(...info.hotMoments.map((h) => Number(h.count) || 0));
  const total = Number(info.total) || 0;
  if (total <= 0) return 0;
  // 峰值占总量比例：越集中越像“全场沸腾的那一刻”
  const ratio = peak / total;
  if (ratio >= 0.1) return 0.6;
  if (ratio >= 0.05) return 0.3;
  return 0;
}
