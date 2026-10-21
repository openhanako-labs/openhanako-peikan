/**
 * lib/browse.js — 浏览循环（P4：接偏好 / 标尺 / 两本日记）
 *
 * 一轮醒来：
 *   1. 决定看不看（每次独立掷）
 *   2. 拉推荐流（初筛 maxVideos）
 *   3. 偏好过滤（dislike 命中的直接剔，like 命中的加权）
 *   4. 挑深读（启发式挑候选，标尺判价值）
 *   5. 深读 + 打分卡
 *   6. 写观察笔记 + 两本日记
 *
 * 不发布任何东西。
 */

import fs from "node:fs";
import path from "node:path";
import * as client from "./client.js";
import * as store from "./store.js";
import { scoreCard } from "./score.js";

const STATE_FILE = "browse-state.json";

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), "utf8")); }
  catch { return { lastWokeAt: null, wakes: 0, history: [], seen: [] }; }
}

function writeState(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, STATE_FILE), JSON.stringify(st, null, 2) + "\n");
  } catch { /* 状态写失败不影响本轮 */ }
}

/** 每次独立掷骰子（不是日期种子） */
export function shouldSkip(skipChance = 0.3) {
  const p = Number(skipChance);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (p >= 1) return true;
  return Math.random() < p;
}

/**
 * 偏好过滤：dislike 命中剔除，like 命中加权。
 */
export function applyPreferences(items, { like = [], dislike = [] } = {}) {
  return items.map((v) => {
    const text = `${v.title || ""} ${v.desc || ""} ${v.up || ""}`;
    const bad = dislike.filter((k) => k && text.includes(k)).length;
    const good = like.filter((k) => k && text.includes(k)).length;
    return { ...v, _pref: { bad, good } };
  }).filter((v) => v._pref.bad === 0);
}

/**
 * 挑候深读：热度 × 新鲜度 × 偏好加权。
 */
export function pickForDeepRead(items, max = 3) {
  const now = Date.now() / 1000;
  return items
    .filter((v) => v.bvid)
    .map((v) => {
      const ageDays = v.pubdate ? Math.max(0.1, (now - v.pubdate) / 86400) : 365;
      const heat = Math.log10(Math.max(10, (v.view || 0) + (v.danmaku || 0) * 10));
      const fresh = 1 / Math.pow(ageDays + 1, 0.35);
      const lenPenalty = v.duration > 3600 ? 0.6 : 1;
      const prefBoost = 1 + Math.min(0.5, (v._pref?.good || 0) * 0.25);
      return { v, score: heat * fresh * lenPenalty * prefBoost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.v);
}

/** 笔记：一句实话。字幕说明“讲了什么”，弹幕说明“哪里炸” */
function noteLine(video, comments, card, sub, dm) {
  const bits = [];
  if (video.up) bits.push(`UP ${video.up}`);
  if (video.view) bits.push(`${(video.view / 10000).toFixed(0)} 万播放`);
  if (sub?.text) bits.push(`字幕 ${sub.lines} 条`);
  const rawTitle = String(video.title || "").slice(0, 40);
  const head = /^《.*》$/.test(rawTitle.trim()) ? rawTitle : `《${rawTitle}》`;
  const flags = [];
  if (card.hasSubtitle) flags.push("有字幕");
  if (card.hasDanmakuHot) flags.push("有炸点");
  const scoreTag = `[${card.total}/20${flags.length ? "·" + flags.join("·") : ""}]`;

  // 弹幕热区的样句最能看出观众在哪一刻嗨了
  const hot = dm?.hotMoments?.[0];
  let tail = "";
  if (hot?.samples?.length) {
    tail = `｜${hot.at}s 处 ${hot.count} 条：${hot.samples[0].slice(0, 30)}`;
  } else if (sub?.text) {
    tail = `｜${sub.text.slice(0, 55)}`;
  } else if (comments?.[0]?.content) {
    tail = `｜热评：${comments[0].content.slice(0, 40)}`;
  }
  return `${scoreTag} ${head}${bits.length ? " · " + bits.join(" · ") : ""}${tail}`;
}

/**
 * 跑一轮浏览。
 * @param {object} cfg { skipChance, maxVideos, deepRead, like, dislike, minScore }
 * @param {object} opts { force?: boolean }
 */
export async function runOnce(sdk, dataDir, cfg = {}, opts = {}) {
  const startedAt = new Date().toISOString();
  const skipChance = Number(cfg.skipChance ?? 0.3);
  const maxVideos = Math.max(1, Number(cfg.maxVideos ?? 5));
  const deepMax = Math.max(0, Math.min(3, Number(cfg.deepRead ?? 2)));
  const st = readState(dataDir);
  const seen = new Set(st.seen || []);

  // 1. 看不看
  if (!opts.force && shouldSkip(skipChance)) {
    const reason = `这次不想看（掷到了那 ${Math.round(skipChance * 100)}%）`;
    writeState(dataDir, {
      ...st,
      lastWokeAt: startedAt,
      wakes: Number(st.wakes || 0) + 1,
      history: [...(st.history || []).slice(-20), { at: startedAt, skipped: true, reason }],
    });
    // 「不想看」也写进私人日记 —— 那是她的日子
    try {
      store.appendDiary(dataDir, "private", `今天没看。${reason}。`);
    } catch { /* 日记失败不影响本轮 */ }
    return { ok: true, skipped: true, reason, startedAt };
  }

  // 2. 拉流
  const feed = await client.feed(sdk, dataDir, { limit: maxVideos });
  if (!feed.ok) {
    writeState(dataDir, {
      ...st,
      lastWokeAt: startedAt,
      history: [...(st.history || []).slice(-20), { at: startedAt, error: feed.note }],
    });
    return { ok: false, error: feed.note, startedAt };
  }

  // 3. 偏好过滤
  const filtered = applyPreferences(feed.items, { like: cfg.like || [], dislike: cfg.dislike || [] });
  const dropped = feed.items.length - filtered.length;

  // 4. 挑候选
  const picked = pickForDeepRead(filtered, Math.max(deepMax, 1));

  // 5-6. 深读 + 打分
  const notes = [];
  const cards = [];
  for (const v of picked) {
    const d = await client.debrief(sdk, dataDir, { bvid: v.bvid, commentLimit: 20 });
    if (!d.ok) continue;
    const subText = d.subtitle?.text || "";
    const card = scoreCard(d.video, d.comments, {
      like: cfg.like, dislike: cfg.dislike, seenBvids: seen,
      minScore: cfg.minScore,
    }, subText, d.danmaku);
    cards.push({
      bvid: d.video.bvid, title: d.video.title,
      hasSubtitle: card.hasSubtitle, hasDanmakuHot: card.hasDanmakuHot,
      ...card,
    });
    store.addNote(dataDir, {
      source: `BV:${d.video.bvid}`,
      kind: "video",
      // 2026-10-21：规则路径以前不写 title，界面上全是「无题」。
      // 她没有参与这一条（机器记的），但至少要一眼能扫——
      // 用视频原题的前 24 字当标题（不假装是她的判断）。
      title: String(d.video.title || "").slice(0, 24),
      summary: noteLine(d.video, d.comments, card, d.subtitle, d.danmaku),
      marks: [card.pass ? "值得说" : "只是看了"],
      // 规则路径手里本来就有完整 video 对象，直接传，不用再查
      bvid: d.video.bvid,
      duration: d.video.duration || 0,
      pubdate: d.video.pubdate || 0,
      up: d.video.up || "",
      pic: d.video.pic || "",
    });
    notes.push({
      bvid: d.video.bvid, title: d.video.title, total: card.total, pass: card.pass,
      hasSubtitle: card.hasSubtitle, subtitleLines: d.subtitle?.lines || 0,
      danmaku: d.danmaku?.total || 0,
      hot: (d.danmaku?.hotMoments || [])[0] || null,
    });
    seen.add(d.video.bvid);
  }

  // 7. 日记 —— 只记事实（给程序看的）
  // 2026-10-20 改：「给主人的那本」不再由代码拼「我觉得你会想看的」。
  // 那句话从来没真发出去过（写日记和分享是两条路），而且口吻也不该由代码定。
  // 两本日记都交给她自己写（bili_diary）；这里只留一本规则日志。
  const endedAt = new Date().toISOString();
  const best = cards.slice().sort((a, b) => b.total - a.total)[0];
  try {
    store.appendDiary(dataDir, "private",
      `醒来 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}。` +
      `看了 ${feed.items.length} 条（偏好滤掉 ${dropped}），深读 ${notes.length} 条。` +
      (notes.length ? `\n有字幕 ${notes.filter((n) => n.hasSubtitle).length}/${notes.length} 条。` : "") +
      (best ? `\n评分最高：《${best.title.slice(0, 36)}》 ${best.total}/20。` : ""),
      "规则模式自动记录"
    );
  } catch { /* 日记失败不影响本轮 */ }

  writeState(dataDir, {
    ...st,
    lastWokeAt: endedAt,
    wakes: Number(st.wakes || 0) + 1,
    seen: Array.from(seen).slice(-300),
    history: [...(st.history || []).slice(-20), {
      at: endedAt, skipped: false, screened: feed.items.length,
      dropped, deepRead: notes.length, best: best ? { bvid: best.bvid, total: best.total } : null,
    }],
  });

  return {
    ok: true, skipped: false, startedAt, endedAt,
    screened: feed.items.length, dropped, deepRead: notes.length,
    notes, cards,
    best: best && best.pass ? best : null,
  };
}

export function status(dataDir) {
  const st = readState(dataDir);
  return {
    lastWokeAt: st.lastWokeAt || null,
    wakes: st.wakes || 0,
    recent: (st.history || []).slice(-5).reverse(),
    seenCount: (st.seen || []).length,
  };
}
