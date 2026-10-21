/**
 * lib/share.js — 把「值得看的」递给她（P12）
 *
 * 她看了一堆东西，但只写进笔记本 —— 你不打开 App 就永远看不到。
 * 这一层负责：**挑出最值得的一条，用通知递给你**。
 *
 * 与 publish 的区别：
 *   publish   = 用她的号在 B站 上公开说话（对外，要过五道闸门）
 *   share     = 递给你一个人看（对内，只走通知）
 *   两者完全独立：share 不需要 kill switch，也不需要白名单。
 *
 * 门槛（防骚扰）：
 *   · 一轮最多推 1 条
 *   · 同一条 BV 不重复推（记在 state 里）
 *   · 每天最多推 N 条（默认 2）
 *   · 必须有 BV 号 —— 没有链接的分享等于没分享
 */

import fs from "node:fs";
import path from "node:path";
import * as notify from "./notify.js";
import * as social from "./social.js";
import * as taste from "./taste.js";
import * as quota from "./quota.js";
import * as store from "./store.js";

const STATE = "share-state.json";

function readState(dataDir) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(dataDir, STATE), "utf8")); } catch { /* 无或坏 */ }
  const today = new Date().toLocaleDateString("sv-SE");

  // day 是「今日计数」的边界；recent 是跨天的推送历史，不随日期清空。
  // 2026-10-20 加：之前整个 state 每天重置，做不到「同一视频 7 天内不重推」。
  if (j && j.day === today) {
    return { ...j, recent: Array.isArray(j.recent) ? j.recent : [] };
  }
  return {
    day: today,
    sent: [],
    count: 0,
    recent: Array.isArray(j?.recent) ? j.recent : [],   // 跨天保留
  };
}

function writeState(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, STATE), JSON.stringify(st, null, 2) + "\n");
  } catch { /* 写失败不影响已发出的通知 */ }
}

/** 从笔记里抽 BV 号 */
export function bvOf(note) {
  const src = String(note?.source || "");
  const m = /(BV[0-9A-Za-z]{10})/.exec(src);
  if (m) return m[1];
  const m2 = /(BV[0-9A-Za-z]{10})/.exec(String(note?.summary || ""));
  return m2 ? m2[1] : "";
}

/**
 * 一条笔记的「标题行」——优先用 title 字段，没有才从 summary 截。
 *
 * 之前只用 summary 第一句，导致：
 *   · 明明存了 title 却不用
 *   · 「有的有日期有的没日期」——日期是从 summary 文本里碰巧带出来的
 */
export function headlineOf(note) {
  const t = String(note?.title || "").trim();
  if (t) return t;

  const s = String(note?.summary || "").trim();
  if (!s) return "";
  const cut = s.split(/[。！？\n]/)[0];
  return (cut || s).slice(0, 60);
}

/**
 * 递一条给她。
 *
 * @param {object} note   笔记对象（store.listNotes 的条目）
 * @param {object} opts   { maxPerDay = 10, prefix = "" }
 * @returns {Promise<{sent:boolean, reason:string, bv?:string}>}
 */
export async function shareNote(sdk, dataDir, note, opts = {}) {
  const maxPerDay = Number(opts.maxPerDay ?? 10);
  const bv = bvOf(note);

  // 1. 没有 BV 号 → 不分享（没链接等于没分享）
  if (!bv) {
    return { sent: false, reason: "这条没有 BV 号，不推（没链接的分享等于没分享）" };
  }

  // 2. 沉默衰减：久未收到表态就降频，归零就不该再推。
  //
  // 2026-10-20 补：之前 share.js 完全不看沉默状态，
  // 而 bili_publish 里有 —— 结果「主人在沉默，她还在自动分享」。
  // 这是同一个行为两个出口、只改了一个的老毛病。
  if (opts.cfg) {
    try {
      const sil = await import("./silence.js");
      const c = sil.canShare(dataDir, opts.cfg);
      if (c && c.ok === false) {
        return { sent: false, reason: `沉默 ${c.state && c.state.days != null ? c.state.days : "?"} 天，分享额度降为 0`, bv, blockedBySilence: true };
      }
    } catch { /* 沉默模块自身出错不阻发 */ }
  }

  // 3. 内容闸门：分享的标题+标记拼成文本过一道确定性规则。
  // 没有正文也可能命中身份信息（标题里出现手机号这种）。
  if (opts.cfg) {
    try {
      const gateMod = await import("./gate.js");
      const probe = [headlineOf(note), ...(Array.isArray(note?.marks) ? note.marks : [])].join(" ");
      const g = gateMod.evaluate({ text: probe, kind: "dm", targetBv: bv }, { newContentType: false });
      if (g.decision !== "ALLOW") {
        return { sent: false, reason: `闸门：${(g.reasons || []).join("；")}`, bv, decision: g.decision };
      }
    } catch { /* 闸门自身出错不阻发 */ }
  }

  const st = readState(dataDir);

  // 4. 今日额度
  //
  // 2026-10-20 统一：以前 share.js 自己维护 shareMaxPerDay，
  // 而 quota.js 里有 shareDaily 这个类型且有 check 分支 —— 但 share.js
  // 从来不记 quota。两个系统各记各的，界面看到的数和实际推送量对不上。
  // 现在：quota 是唯一真相，shareMaxPerDay 仅作兼容回退。
  let cap = maxPerDay;
  // 上限优先级：显式 opts.maxPerDay > 配置 quota.shareDaily > 默认 10
  if (opts.maxPerDay === undefined || opts.maxPerDay === null) {
    const caps = { ...quota.DEFAULTS, ...((opts.cfg || {}).quota || {}) };
    const qcap = Number(caps.shareDaily);
    if (Number.isFinite(qcap) && qcap > 0) cap = qcap;
  }

  if (Number(st.count || 0) >= cap) {
    return { sent: false, reason: `今日已推 ${st.count} 条（上限 ${cap}）`, bv };
  }

  // 5. 同一视频 N 天内不重推（默认 7 天）
  //   source 仓库的写死限制："同一视频 7 天内一次"。
  //   我之前只做了「永义不重复」（st.sent 只存今天），跨天就忘了。
  const coolDays = Number(opts.sameVideoDays ?? 7);
  if (coolDays > 0) {
    const cutoff = Date.now() - coolDays * 86400000;
    const hit = (st.recent || []).find((x) => x.bv === bv && Number(x.at || 0) >= cutoff);
    if (hit) {
      const daysAgo = Math.floor((Date.now() - Number(hit.at)) / 86400000);
      return {
        sent: false,
        reason: `这条 ${daysAgo} 天前推过，${coolDays} 天内不重推`,
        bv, cooled: true, lastAt: new Date(Number(hit.at)).toISOString(),
      };
    }
  }

  // 6. 同一条不重复推（今天内）
  if (Array.isArray(st.sent) && st.sent.includes(bv)) {
    return { sent: false, reason: `这条 BV${bv} 今天已经推过了`, bv };
  }

  // 4. 发分享
  //
  // 2026-10-21 改：不再拼固定排版。
  //
  // 以前不管怎样都是「标题 \n 标记 \n 链接」，三条一模一样——
  // 那不像她在递东西，像系统推的一个卡片。
  //
  // 现在：她写什么就发什么（opts.say）。
  // 只有她没写时，才退回标题（单行）+ 链接。
  const say = String(opts.say || "").trim();
  const head = headlineOf(note);
  const link = `https://www.bilibili.com/video/${bv}/`;

  const body = say
    ? `${say}\n${link}`          // 她自己说的话 + 链接
    : `${head}\n${link}`;        // 没说话，就只给标题 + 链接

  // 主通道：B站 私信（真正把东西送到收件箱）
  // 兜底：私信不行（未互关 / 未开点对点）才退回系统通知
  let via = "dm";
  let r = await social.sendDm(sdk, dataDir, {
    toMid: String(opts.toMid || ""),
    text: body,
    live: opts.live !== false,
  });

  if (!r.ok) {
    via = "notify";
    const n = await notify.push(sdk, dataDir, {
      title: "奥菲莉娅 · 这条你可能想看",
      body,
    });
    if (!n.ok) {
      return {
        sent: false,
        reason: `私信：${r.reason || r.error || "失败"}；通知：${n.skipped || "失败"}`,
        bv, blocked: r.blocked === true,
      };
    }
    r = { ok: true, mode: "notify-fallback" };
  }

  writeState(dataDir, {
    day: st.day,
    sent: [...(st.sent || []), bv],
    count: Number(st.count || 0) + 1,
    // recent 跨天保留，用于「同一视频 N 天内不重推」。
    // 只留 90 天内的，避免无限涨。
    recent: [
      ...(st.recent || []).filter((x) => Number(x.at || 0) >= Date.now() - 90 * 86400000),
      { bv, at: Date.now() },
    ],
  });

  // 同步进 quota（2026-10-20）：分享也是对外动作，该在同一个账本里。
  // 以前两套账分开记，界面看不到真实推送量。
  try {
    quota.record(dataDir, { type: "share", target: bv, note: String(body).slice(0, 40), share: true });
  } catch { /* 记账失败不影响已发出的 */ }
  return {
    sent: true,
    reason: via === "dm" ? "已私信给你" : "已发通知（私信不可用）",
    bv, via,
    preview: body,
  };
}

/**
 * 一轮醒来后：从这一轮新写的笔记里挑一条递出去。
 *
 * 挑选规则（确定性，不交模型）：
 *   1. 必须带 BV
 *   2. 优先 marks 多的（她自己标记越多，说明越有话说）
 *   3. 同分时取最新的
 *
 * @param {Array} notes  这一轮新写的笔记（按时间正序）
 */
export async function shareFromRound(sdk, dataDir, notes = [], opts = {}) {
  const candidates = (notes || []).filter((n) => bvOf(n));
  if (!candidates.length) {
    return { sent: false, reason: "这一轮没有带 BV 的笔记" };
  }

  // 排序：marks 数量（她自己标了几个点）+ 口味分
  //
  // 为什么把口味放进来：之前只看 marks 数量，意味着「推什么给你」
  // 跟你的反馈毫无关系。现在她的偏好档案（含你的反馈）参与挑选。
  const ranked = candidates
    .map((n) => {
      const marks = Array.isArray(n.marks) ? n.marks.length : 0;
      // 把标题、判断、marks 拼起来算口味（她写过的东西里藏着主题）
      const text = [
        n.title || "", n.summary || "",
        ...(Array.isArray(n.marks) ? n.marks : []),
      ].join(" ");
      let tasteScore = 0;
      try { tasteScore = taste.scoreFor(dataDir, text).score; } catch { /* 口味算失败不影响主流程 */ }
      // 权重：marks 是她的主动标记，权重高；口味是长期倾向，权重低但跨轮累积
      return { n, marks, tasteScore, weight: marks + tasteScore * 1.5 };
    })
    // 口味太负（<-0.5）的直接不推——她已经知道你/她都不爱看这类
    .filter((x) => x.tasteScore > -0.5)
    .sort((a, b) => (b.weight - a.weight) || String(b.n.at || "").localeCompare(String(a.n.at || "")));

  if (!ranked.length) {
    return { sent: false, reason: "这一轮的内容都被口味过滤掉了" };
  }

  // 只试第一条（一轮最多推一条）
  const r = await shareNote(sdk, dataDir, ranked[0].n, opts);
  return { ...r, picked: { marks: ranked[0].marks, tasteScore: ranked[0].tasteScore } };
}

/** 读分享状态 */
export function status(dataDir) {
  const st = readState(dataDir);
  return { day: st.day, count: st.count || 0, sent: st.sent || [] };
}
