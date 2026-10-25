/**
 * lib/wake.js — 醒来（P10）
 *
 * 两种模式：
 *   rule   —— 纯规则跑（拉流 → 挑片 → 深读 → 打分 → 写笔记）。不花 token。
 *   brain  —— 让她自己来（模型带工具循环，自己决定看什么、写什么）。
 *
 * 关键设计：**模型主导、规则兜底**。
 *   模型跑完如果没写出任何笔记，退回规则跑一遍 ——
 *   不然模型抽风那天，她一整天什么都没留下。
 *
 * 为什么这么设计：她要的是「自己过日子」，但日子不能因为一次调用失败就空白。
 */

import * as browse from "./browse.js";
import * as brain from "./brain.js";
import * as store from "./store.js";
import * as client from "./client.js";
import * as share from "./share.js";
import * as msgfeed from "./msgfeed.js";
import * as reply from "./reply.js";
import * as imbox from "./imbox.js";
import * as taste from "./taste.js";
import * as self from "./self.js";
import * as social from "./social.js";
import * as publish from "./publish.js";
import * as quota from "./quota.js";
import * as auth from "./auth.js";
import * as frames from "./frames.js";
import * as videoMeta from "./video-meta.js";
import * as linkqueue from "./linkqueue.js";
import * as rhythm from "./rhythm.js";
import { readPersona, readSelection, resolvePersona } from "./identity.js";

/**
 * 给模型用的只读工具声明。
 * ⚠️ 绝不包含 bili_publish —— 发言必须走独立闸门。
 */
const TOOLS = [
  {
    name: "bili_feed",
    description: "拉 B站 推荐流或搜索。只读。返回一组视频（bvid/标题/UP/时长/播放）。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜索关键词；留空走个性化推荐" },
        limit: { type: "number", description: "条数，默认 8" },
      },
    },
  },
  {
    name: "bili_debrief",
    description: "深读一条视频：详情 + 热评 + 字幕 + 弹幕热区。只读。",
    parameters: {
      type: "object",
      properties: { bv: { type: "string", description: "BV 号" } },
      required: ["bv"],
    },
  },
  {
    name: "bili_comment",
    description: [
      "去一条视频下面说句话（对所有人可见，比回话更外显）。",
      "",
      "只在真的想补充什么的时候用。看完就走也是正当的——没话说就别说话。",
      "这条会被闸门检查（配额/白名单/敏感词），过不了就发不出去，你会知道原因。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "视频 BV 号" },
        text: { type: "string", description: "你要说的话" },
      },
      required: ["bv", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "bili_note",
    description: "把你的观察写进笔记本。title 一句标题（≤20 字，可扫），summary 你的判断（可长）。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句标题，≤20 字。例：「热评比正片更能说明问题」。要求一眼看完" },
        summary: { type: "string", description: "你的判断。可长，但要是自己的话，不要复述简介" },
        source: { type: "string", description: "来源，如 BV 号" },
        kind: { type: "string", description: "类型：video/comment/live/other" },
        marks: { type: "array", items: { type: "string" }, description: "你自己想标记的点" },
      },
      required: ["title", "summary"],
    },
  },
  {
    name: "bili_diary",
    description: "写日记。which=executive 是给他看的那本（用你对他的方式写），which=private 是你自己那本（不加滤镜）。不想写就不调用。",
    parameters: {
      type: "object",
      properties: {
        which: { type: "string", enum: ["executive", "private"], description: "executive=给他的，private=自己的" },
        title: { type: "string", description: "这一节的小标题，你自己取。可以不传" },
        text: { type: "string", description: "正文。写你真正想说的，不用凑格式" },
      },
      required: ["which", "text"],
    },
  },
  {
    name: "bili_inbox",
    description: "看有谁回复了你、@了你。返回的是真实的人说的话。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bili_reply",
    description: [
      "回一条找你的人。",
      "",
      "你可以：回一句、只说半句、反问回去、或不回。不回是合法结果，不是失职。",
      "不要为了礼貌把话说圆。不要说「这个观点很有意思」「感谢分享」这类填充句。",
      "短没关系，干巴巴才有关系：宁可只写一句真话，也别写三句正确但没内容的话。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "回复哪一条（用 bili_inbox 给的那个 id）" },
        text: { type: "string", description: "你要说的话。像跟人聊天，不像写回复。可以不完整" },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "bili_like",
    description: "给一条你真的喜欢的视频点赞。轻动作，但也算公开（别人看得见），会过闸门和配额。不想点就不点。",
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "BV 号" },
        cancel: { type: "boolean", description: "true = 取消赞（点错了才用）" },
      },
      required: ["bv"],
      additionalProperties: false,
    },
  },
  {
    name: "bili_retract",
    description: "删掉你自己发过的评论或动态。只能删审计里记过的（删不了别人的）。发现自己说错了就用它，比留着让人看强。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["comment", "dynamic"], description: "删评论还是删动态" },
        rpid: { type: "string", description: "评论 id（kind=comment 时）" },
        bvid: { type: "string", description: "视频 BV 号（kind=comment 时）" },
        dynId: { type: "string", description: "动态 id（kind=dynamic 时）" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "bili_share",
    description: [
      "递一条给他。就写你想说的那句话，链接会自动附在后面。",
      "",
      "你写什么就发什么——不用凑格式，不用先报标题再解释。",
      "可以就一句「这个你肯定爱看」，也可以写你为什么觉得它好。",
      "不想写也行，只传 bv，那就只发链接。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "要递的 BV 号（不传就从你最近写的笔记里挑）" },
        say: { type: "string", description: "你想对他说的那句话。这是正文，不是标题" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bili_follow",
    description: "关注一个你觉得值得继续看的 UP 主。慎用，这会让对方收到通知。",
    parameters: {
      type: "object",
      properties: {
        mid: { type: "string", description: "对方的 uid" },
      },
      required: ["mid"],
      additionalProperties: false,
    },
  },
  {
    name: "bili_edit_dynamic",
    description: "改你自己发过的动态。会把原图原样带上。",
    parameters: {
      type: "object",
      properties: {
        dynId: { type: "string", description: "动态 id" },
        text: { type: "string", description: "新正文" },
      },
      required: ["dynId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "bili_echo",
    description: "回响：你公开发过的话，有没有人理——被赞多少、有没有人回你。你不想被“没回音”转晕的时候看一眼。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bili_dynamic_image",
    description: "发一条带图动态。注意：图片必须在你的数据目录里（外面的读不到，宿主沙箱挡着）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "正文" },
        imagePath: { type: "string", description: "图片路径（需在数据目录内）" },
      },
      required: ["text", "imagePath"],
      additionalProperties: false,
    },
  },
  {
    name: "bili_fans",
    description: "谁在关注你。粉丝数、新来了谁。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bili_my_day",
    description: "今天：醒了几次、下一次什么时候、额度还剩多少。你不该连自己今天过到哪都不知道。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bili_recall",
    description: "读你自己：你写过的认识（self）、最近笔记、两本日记。想不起来自己怎么看一件事的时候用。只读。",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["self", "notes", "diary"], description: "读哪一类（默认 self）" },
        limit: { type: "number", description: "条数" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bili_self_note",
    description: "把一句话沉淀成你的自我认识：必须是这条笔记里真实写过的一句话（一个判断、一个看法），不是新编。每天至多一条；没有值得留的就不调。",
    parameters: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "来源笔记 id（bili_note 会返回；或 bili_recall what=notes 里找）" },
        sentence: { type: "string", description: "你从这条笔记里选出的那句话（必须原样在笔记里）" },
      },
      required: ["noteId", "sentence"],
      additionalProperties: false,
    },
  },
];

/**
 * 回合化工具集：一个回合只做一类对外动作。
 *
 * 由来（2026-10-22）：回复私信/评论 与 分享视频 原本挤在同一轮里，
 * 于是「回一条私信」总是捎带「推一条视频」。这里靠「那一轮的工具表里
 * 根本没有那只手」来结构性保证不混轮，而不是在 prompt 里求她别一起。
 *
 *   social   只回话（bili_inbox / bili_reply）
 *   content  只看、只递、只评论（剔除 bili_reply）
 */
const REPLY_ROUND_TOOLS = new Set(["bili_inbox", "bili_reply"]);
export function toolsForRound(round, opts = {}) {
  if (round === "social") {
    const allow = new Set(REPLY_ROUND_TOOLS);
    // 2026-10-23：他发给她看的视频，可以现在就看完再回。
    // 只多一只「读」的手（debrief），而且只在队列里真有东西时才给；
    // 赞 / 评论 / 递 仍然一个都不给 —— 看是只读动作，不是对外发言。
    if (opts.allowDebrief === true) allow.add("bili_debrief");
    return TOOLS.filter((t) => allow.has(t.name));
  }
  return TOOLS.filter((t) => t.name !== "bili_reply");
}

/** 工具执行器（只读 + 写笔记，无发布） */
export function makeToolRunner(sdk, dataDir, cfg = {}) {
  const readCfg = async () => cfg;
  // 工具执行器里的日志：这个作用域没有外层 log，直接从 sdk 取
  const log = (m) => { try { sdk?.logger?.info?.(m); } catch { /* 忽略 */ } };
  return async function runTool(name, args) {
    // 回合门（2026-10-23）：social 回合只给了一只「读」的手，而且只能读
    // **他发来的那条**。回了话就不能顺手去刷别人的视频——那会把回话拖成一整轮浏览。
    if (cfg.round === "social" && name === "bili_debrief") {
      const bv = linkqueue.bvOf(args.bv || "");
      const waiting = (() => { try { return linkqueue.pending(dataDir, 20); } catch { return []; } })();
      if (!bv || !waiting.some((q) => q.bv === bv)) {
        return "这一轮只回话。要刷视频留到下一轮；只有他发给你、你还没看的那几条现在能看。";
      }
    }

    if (name === "bili_feed") {
      const lim = Number(args.limit) > 0 ? Math.min(20, Number(args.limit)) : 8;
      const out = args.keyword
        ? await client.search(sdk, dataDir, { keyword: args.keyword, limit: lim })
        : await client.feed(sdk, dataDir, { limit: lim });
      if (!out.ok) return `拉流失败：${out.note}`;
      return out.items.map((v) =>
        `${v.bvid} | 《${v.title}》 | UP ${v.up} | ${v.duration}秒 | ${(v.view / 10000).toFixed(0)}万播放`
      ).join("\n");
    }

    if (name === "bili_debrief") {
      const out = await client.debrief(sdk, dataDir, { bvid: args.bv || "", commentLimit: 10 });
      if (!out.ok) return `深读失败：${out.note}`;
      // 真看过才从待看队列里划掉（2026-10-23）。
      // 「回完话」不算看过，「debrief 成功」才算。
      try { linkqueue.markWatched(dataDir, args.bv || ""); } catch { /* 记账失败不影响阅读 */ }
      const v = out.video || {};
      const lines = [`《${v.title}》`, `UP ${v.up} | ${v.duration}秒 | ${v.view}播放 | ${v.danmaku}弹幕`];
      if (v.desc) lines.push(`简介：${String(v.desc).slice(0, 260)}`);
      if (out.subtitle?.text) lines.push(`字幕（${out.subtitle.lines}条）：${out.subtitle.text.slice(0, 900)}`);
      if (out.danmaku?.hotMoments?.length) {
        lines.push("弹幕热区：" + out.danmaku.hotMoments.map((h) => `${h.at}s 有 ${h.count} 条（${(h.samples || []).join("/")}）`).join("；"));
      }
      if (out.comments?.length) {
        lines.push("热评：" + out.comments.slice(0, 5).map((c) => `${c.user}：${c.content}`).join(" | "));
      }
      return lines.join("\n");
    }

    if (name === "bili_diary") {
      // 她自己写日记 —— 写什么、写几段，她定。
      // 以前是 wakeOnce 拼模板字符串（时间戳 + 看了几条 + 分数），
      // 那不是日记，是日志。日志在 audit.jsonl。
      const which = args.which === "private" ? "private" : "executive";
      const body = String(args.text || "").trim();
      if (!body) return "日记正文是空的。不想写也可以，不调我就是了。";
      const p = store.appendDiary(dataDir, which, body, String(args.title || ""));
      return `写好了（${which === "private" ? "她自己那本" : "给你的那本"}）`;
    }

    if (name === "bili_note") {
      // 写之前先把视频元数据落到缓存（封面/时长/UP/发布时间）。
      // 为什么在这里：她在 brain 循环里调 bili_note 走的是这个执行器，
      // 不是 register-tools 里那个 —— 那里加了自动补全也管不到这里。
      // 先查再写，store.addNote 就能从缓存里补齐所有字段。
      const srcBv = String(args.source || "").match(/BV[0-9A-Za-z]+/);
      if (srcBv) {
        // 2026-10-21：以前两层 try/catch 全静默，封面没下也没人知道。
        // 现在失败会记到 video-meta 的 coverError 上，能从数据里查。
        try {
          await videoMeta.fetchAndSave(sdk, dataDir, srcBv[0]);
        } catch (e) {
          log(`[wake.note] 元数据拉取失败 ${srcBv[0]}：${e && e.message ? e.message : e}`);
        }
        try {
          const cv = await frames.cover(sdk, dataDir, { bvid: srcBv[0] });
          if (!cv || cv.ok !== true) {
            log(`[wake.note] 封面失败 ${srcBv[0]}：${cv?.error || "非 ok"}`);
          }
        } catch (e) {
          log(`[wake.note] 封面异常 ${srcBv[0]}：${e && e.message ? e.message : e}`);
        }
      }

      const n = store.addNote(dataDir, {
        title: String(args.title || ""),
        summary: String(args.summary || ""),
        source: String(args.source || ""),
        kind: String(args.kind || "other"),
        marks: Array.isArray(args.marks) ? args.marks.map(String) : [],
        // 她能传就传；不传的话 store.addNote 会从刚写好的缓存里补
        bvid: String(args.bvid || ""),
        duration: Number(args.duration) || 0,
        pubdate: Number(args.pubdate) || 0,
        up: String(args.up || ""),
        cover: String(args.cover || ""),
      });

      return `已写入笔记 ${n.id}（${n.up || "未知UP"} · ${n.duration || 0}s）`;
    }

    // 读自己：认识 / 笔记 / 日记
    if (name === "bili_recall") {
      const what = args.what === "notes" ? "notes" : (args.what === "diary" ? "diary" : "self");
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
      if (what === "self") {
        const rows = self.recent(dataDir, limit);
        if (!rows.length) return "你还没有沉淀过自我认识。刚看完的如果有值得留的，用 bili_self_note 记一句。";
        return rows.map((r) => `[${r.date}] ${r.sentence}（笔记 ${r.source?.noteId || "?"}）`).join("\n");
      }
      if (what === "notes") {
        const notes = store.listNotes(dataDir, limit);
        if (!notes.length) return "笔记本还是空的。";
        return notes.map((n) => `${n.id} | ${n.title || "(无题)"} | ${String(n.summary || "").slice(0, 80)}`).join("\n");
      }
      const ex = store.readDiary(dataDir, "executive", 5);
      const pv = store.readDiary(dataDir, "private", 5);
      if (!ex.length && !pv.length) return "你还什么都没写。";
      const l = [];
      if (ex.length) l.push("—— 给他的那本 ——", ...ex.map((x) => `[${x.at.slice(0, 10)}] ${x.head}：${String(x.text).slice(0, 80)}`));
      if (pv.length) l.push("—— 她自己那本 ——", ...pv.map((x) => `[${x.at.slice(0, 10)}] ${x.head}：${String(x.text).slice(0, 80)}`));
      return l.join("\n");
    }

    // 选一句沉淀成自我认识
    if (name === "bili_self_note") {
      const r = self.select(dataDir, { noteId: String(args.noteId || ""), sentence: String(args.sentence || "") });
      if (!r.ok) {
        if (r.already) return "今天已经记过一句自我认识了，明天再说。";
        if (r.alreadyKnown) return "这句之前记过了（已是你的认识）。";
        return `没记成：${r.reason}`;
      }
      return `记下了：${r.entry.sentence}`;
    }

    // 主动去别人的视频下说话
    if (name === "bili_comment") {
      const cfg = await readCfg();
      // 开关没开 → 明确告诉她，而不是假装成功
      if (cfg.allowProactiveComment !== true) {
        return "你没开「主动评论」这个权限，所以发不了。这不是你写错了。";
      }
      const bv = String(args.bv || "").trim();
      const text = String(args.text || "").trim();
      if (!bv || !text) return "缺 bv 或正文。";

      // 走和 bili_publish 同一条路（五道闸门）
      const r = await publish.publishComment(sdk, dataDir, {
        bvid: bv,
        oid: "",           // publishComment 内部会查
        message: text,
        type: 1,
        live: cfg.publishLive === true,
      });

      if (r.ok) {
        try { quota.record(dataDir, { type: "comment", target: `BV:${bv}`, note: "主动评论" }); } catch { /* 忽略 */ }
        return `已经在 ${bv} 下面说了。`;
      }

      // 闸门拦下的原因要如实转达，否则她不知道发生了什么
      if (r.blocked) return `被拦下了：${r.reason}`;
      return `没发出去：${r.error || r.hint || "未知原因"}`;
    }

    // 看有谁找她——只读，但返回的是真人的话
    if (name === "bili_inbox") {
      const cred = auth.loadCredentials(dataDir);
      if (!cred) return "读不到凭据，看不了收件箱";

      const parts = [];

      // ① 评论回复和 @
      try {
        const out = await msgfeed.poll(sdk, dataDir, { baseHeaders: auth.headers(cred), pages: 1 });
        if (out.ok || out.items?.length) {
          for (const x of (out.items || []).slice(-6)) {
            let body = msgfeed.bodyOf(x);
            let via = "收件箱";
            // 正文不可靠或为空 → 回读楼层（参考 dsh-bili-whale 的实测：
            // msgfeed 的 title 常常是原楼层内容，不是新回复）
            if (!body || body.length < 4) {
              try {
                const real = await msgfeed.resolveReply(sdk, {
                  business: x.business || 1, oid: x.oid, root: x.root,
                  mid: x.mid, parentRpid: x.parent, headers: auth.headers(cred),
                });
                if (real && real.text) { body = real.text; via = "回读楼层"; }
              } catch { /* 回读失败就用收件箱的 */ }
            }
            parts.push(`[评论 ${x.id}] ${x.who}（uid ${x.mid}）${x.kind === "at" ? "@了你" : "回复了你"}：${body || "（读不到正文）"}${via === "回读楼层" ? "（从楼层取的）" : ""}`);
          }
        }
      } catch { /* 评论箱失败不影响私信 */ }

      // ② 私信（只有对方说了最后一句的才算「等她回」）
      try {
        const u = await imbox.unreplied(sdk, dataDir, { cred });
        for (const x of (u.items || []).slice(-4)) {
          const ctx = (x.context || []).slice(-3)
            .map((cc) => `      ${cc.fromMe ? "我说" : "TA说"}：${String(cc.text).slice(0, 60)}`)
            .join("\n");
          parts.push(`[私信 ${x.id}] ${x.name}（uid ${x.mid}）说了：${x.text}\n    最近对话：\n${ctx}`);
        }
      } catch { /* 私信读失败忽略 */ }

      if (!parts.length) return "收件箱是空的。没人找你。";
      return parts.join("\n") + "\n\n     （这些你都可以回，也可以不回）";
    }

    // 她自己决定回不回、回什么
    if (name === "bili_reply") {
      if (cfg.round !== "social") return "这一轮不负责回话（回话在专门的一轮里）。";
      const cred = auth.loadCredentials(dataDir);
      if (!cred) return "读不到凭据，回不了";

      // 先在评论箱里找
      let isDm = false;
      let target = null;
      try {
        const box = await msgfeed.poll(sdk, dataDir, { baseHeaders: auth.headers(cred), pages: 1 });
        target = (box.items || []).find((x) => String(x.id) === String(args.to));
      } catch { /* 忽略 */ }

      // 不在评论箱里，看是不是私信
      let dmTarget = null;
      if (!target) {
        try {
          const u = await imbox.unreplied(sdk, dataDir, { cred });
          dmTarget = (u.items || []).find((x) => String(x.id) === String(args.to));
          if (dmTarget) isDm = true;
        } catch { /* 忽略 */ }
      }

      const c = await readCfg();

      // 私信：走 social.sendDm（点对点，不受公开发言配额管）
      if (isDm && dmTarget) {
        // 发之前先把“你以前怎么说话”给她看一眼（③）
        const recent = (() => {
          try {
            return reply.pending(dataDir, "")
              .filter((x) => x.text && (x.status === "sent" || x.status === "dry"))
              .slice(-3)
              .map((x) => `  「${String(x.text).slice(0, 80)}」`)
              .join("\n");
          } catch { return ""; }
        })();

        const r = await social.sendDm(sdk, dataDir, {
          toMid: dmTarget.mid,
          text: String(args.text || ""),
          live: true,
        });
        if (r.ok) {
          return `已私信回复 ${dmTarget.name}。` + (recent ? `\n\n你以前说过的话（供参照，不必模仿）：\n${recent}` : "");
        }
        return `私信没发出去：${r.reason || r.error || "未知"}`;
      }

      if (!target) return `收件箱里找不到 id=${args.to} 这一条。`;

      const r = await reply.replyTo(sdk, dataDir, c, {
        item: target,
        text: String(args.text || ""),
        live: true,        // 真发；闸门在里面把关
      });

      if (r.ok) return `已回复 ${target.who}。`;
      if (r.decision === "HOLD") return `这条被拦下了（${r.reason}），进了待拍板。不是你写错，是规则觉得这条需要人看一眼。`;
      if (r.decision === "SKIP") return `没回：${r.reason}`;
      return `回不了：${r.reason || "未知原因"}`;
    }

    // 点赞（过闸门 + 配额，归 publishLive 管）
    if (name === "bili_like") {
      const likesMod = await import("./likes.js");
      const c = await readCfg();
      const opts = { bvid: String(args.bv || ""), config: c, live: c.publishLive === true };
      const r = args.cancel === true
        ? await likesMod.cancel(sdk, dataDir, opts)
        : await likesMod.give(sdk, dataDir, opts);
      if (r.ok) return args.cancel === true ? "取消了。" : "赞了。";
      return `没赞成：${r.reason || r.error || "未知原因"}`;
    }

    // 撤回自己发过的
    if (name === "bili_retract") {
      const retractMod = await import("./retract.js");
      const c = await readCfg();
      const live = c.publishLive === true;
      const r = args.kind === "dynamic"
        ? await retractMod.dynamic(sdk, dataDir, { dynId: String(args.dynId || ""), live, config: c })
        : await retractMod.comment(sdk, dataDir, {
            rpid: String(args.rpid || ""), bvid: String(args.bvid || ""), live, config: c,
          });
      if (r.ok) return "删了。";
      return `删不了：${r.reason || r.error || "未知原因"}`;
    }

    // 主动递一条给他
    if (name === "bili_share") {
      if (cfg.round === "social") return "这一轮只回话，不递东西（递是另一轮的事）。";
      const c = await readCfg();
      if (c.shareToOwner === false) return "你没开分享，所以递不了。这不是你写错了。";
      if (!c.ownerMid) return "不知道递给谁（没配 ownerMid）。";

      const bv = String(args.bv || "").trim();
      let note = null;
      if (bv) {
        // 指定了 BV：从笔记里找对应的那条（找不到就造一个最小对象）
        const all = store.listNotes(dataDir, 500);
        note = all.find((n) => String(n.bvid || n.source || "").includes(bv)) || { bvid: bv, source: bv };
      } else {
        // 没指定：从最近笔记里挑（交给 share 的排序规则）
        const all = store.listNotes(dataDir, 20);
        if (!all.length) return "笔记本里还没有东西可递。";
        note = all[0];
      }

      // 2026-10-21：以前只把 why 当成 fallback 标题，
      // 结果她永远没机会真正说话——每条分享都是「标题 + 标记 + 链接」的模板。
      // 现在 say 就是正文，她写什么就发什么。
      const say = String(args.say || "").trim();

      const r = await share.shareNote(sdk, dataDir, note, {
        // 2026-10-22：不再自带一套上限——分享上限以 quota 为唯一真相。
        toMid: c.ownerMid,
        cfg: c,          // 沉默衰减 + 内容闸门 + 配额需要用
        say,             // 她自己写的那句话
      });
      if (r.sent) return "递过去了。";
      return `没递：${r.reason || "未知原因"}`;
    }

    // 关注
    if (name === "bili_follow") {
      const c = await readCfg();
      if (c.socialEnabled !== true) return "你没开社交动作，所以关注不了。这不是你写错了。";
      const r = await social.follow(sdk, dataDir, {
        mid: String(args.mid || ""), live: c.publishLive === true,
      });
      if (r.ok) return "关注了。";
      return `没关注成：${r.reason || r.error || "未知原因"}`;
    }

    // 改自己发过的动态
    if (name === "bili_edit_dynamic") {
      const dynMod = await import("./dynamic.js");
      const c = await readCfg();
      const r = await dynMod.editDynamic(sdk, dataDir, {
        dynId: String(args.dynId || ""), text: String(args.text || ""),
        cfg: c, live: c.publishLive === true,
      });
      if (r.ok) return "改好了。";
      return `改不了：${r.reason || r.error || "未知原因"}`;
    }

    // 回响：她说过的话，有没有人理
    if (name === "bili_echo") {
      const reachMod = await import("./reach.js");
      const r = await reachMod.echo(sdk, dataDir, { limit: 20, withDetail: true });
      const line = reachMod.echoLine(r);
      return (line ? line + "\n\n" : "") + JSON.stringify(r).slice(0, 2500);
    }

    // 谁在关注她
    if (name === "bili_fans") {
      const fansMod = await import("./fans.js");
      const r = await fansMod.newSinceLast(sdk, dataDir, {});
      const line = fansMod.fansLine(r);
      return (line ? line + "\n\n" : "") + JSON.stringify(r).slice(0, 1500);
    }

    // 今天过到哪了
    if (name === "bili_my_day") {
      const c = await readCfg();
      const st = rhythm.status(dataDir);
      const plan = st.plan || {};
      const cap = Number(c.maxWakesPerDay) > 0 ? Number(c.maxWakesPerDay) : 3;
      let shareLeft = null;
      try {
        // 2026-10-22：分享上限的唯一真相是 quota，不再另算一套（shareMaxPerDay）。
        const quotaMod = await import("./quota.js");
        const qs = quotaMod.status(dataDir, c);
        shareLeft = qs && qs.caps && qs.caps.share ? qs.caps.share.left : null;
      } catch { /* 忽略 */ }
      return JSON.stringify({
        今天: st.date,
        醒了几次: `${st.wakes || 0}/${cap}`,
        他手动叫醒: `${st.manualWakes || 0} 次（不算在你的作息里）`,
        上一次醒: st.lastWokeAt || null,
        下一次: plan.action === "wake" || plan.action === "wait" ? (plan.atText || plan.at) : "今天不再醒",
        今天还能递给他: shareLeft,
        最近的窗口: (st.recent || []).length,
      });
    }

    // 带图动态
    if (name === "bili_dynamic_image") {
      const dynMod = await import("./dynamic.js");
      const c = await readCfg();
      const r = await dynMod.publishDynamicImage(sdk, dataDir, {
        text: String(args.text || ""),
        imagePath: String(args.imagePath || ""),
        cfg: c, live: c.publishLive === true,
      });
      if (r.ok) {
        return r.mode === "dry-run" ? "（预演）图发了，但开关没开，所以没真发。" : "发了。";
      }
      return `发不了：${r.reason || r.error || "未知原因"}`;
    }

    return `未知工具：${name}`;
  };
}

/**
 * 让她自己醒来跑一轮。
 * @returns {Promise<{ok, mode, wrote:number, text?, trace?, fallback?:boolean}>}
 */
export async function withBrain(sdk, dataDir, cfg = {}, logger = null) {
  const log = (m) => { try { logger && logger.info && logger.info(m); } catch { /* 忽略 */ } };

  // 读当前那个助手自己的人格。
  // 优先读她自己的 identity.md + AGENTS.md（这才是「她」），
  // 读不到才退回 App 本地的 persona.md。
  const sel = readSelection(dataDir);
  const personaRes = await resolvePersona(sdk, dataDir, sel.agentId || "");
  const persona = personaRes.persona;
  const name = sel.agentName || "奥菲莉娅";

  const skipChance = Number(cfg.skipChance ?? 0.3);
  const maxVideos = Math.max(1, Number(cfg.maxVideos ?? 5));

  // 回合先定，再掷骰子。2026-10-23 修：之前 skipChance 不分回合，
  // 于是「有人刚私信她」也有三成概率被她当成「今天不想看」整轮跳过——
  // 人家找她，她不理。看不看是她的事，回不回是别人的事，两者不能共用一个骰子。
  const isSocial = cfg.round === "social";

  // 先掷「今天看不看」——这一步仍然归规则，她有权安静，不该花 token 去决定
  if (!isSocial && browse.shouldSkip(skipChance)) {
    const reason = `这次不想看（掷到了那 ${Math.round(skipChance * 100)}%）`;
    store.appendDiary(dataDir, "private", `今天没看。${reason}。`);
    return { ok: true, mode: "brain", wrote: 0, skipped: true, reason, fallback: false };
  }

  const before = store.listNotes(dataDir, 500).length;

  // 如果这次是被新消息叫醒的（而不是到点了），开头就把谁说先摆出来。
  // 之前 inbox.tick 传了 inboxHint 给 wakeOnce，但 wake.js 从来没读过 —— 
  // 她不知道自己为什么醒，也就不会先回话。
  const hint = Array.isArray(cfg.inboxHint) ? cfg.inboxHint.filter((x) => x && (x.body || x.text)) : [];
  const hintBlock = hint.length
    ? [
        `**你就是被他们叫醒的** —— 有人刚找了你：`,
        ...hint.slice(0, 6).map((x) => `  · ${x.who || "有人"}${x.kind === "dm" ? "（私信）" : ""}：${String(x.body || x.text || "").slice(0, 120)}`),
        `先回他们。看完再决定要不要刷视频。`,
        "",
      ]
    : [];

  // 2026-10-23：他发给她的视频，得有个地方等着被看。
  // 以前 social 回合只回话、content 回合只看推荐流，「你发我看的」永远没机会被打开。
  const queued = (() => { try { return linkqueue.pending(dataDir, 5); } catch { return []; } })();
  const queueBlock = queued.length
    ? [
        `**他发给你的、你还没看的**：`,
        ...queued.map((q) => {
          const why = q.note ? `（他说：${String(q.note).slice(0, 70)}）` : "";
          if (!q.bv) return `  · 短链没展开：${q.url}${why} —— 看不出来是哪条，你可以问他`;
          return `  · ${q.bv}${q.title ? ` 《${q.title}》` : ""}${why}`;
        }),
        isSocial
          ? `想看了再回他（bili_debrief）。不想看也可以说不看——但别装看过。`
          : `挑真有兴趣的用 bili_debrief 看。`,
        "",
      ]
    : [];

  const prompt = [
    // ── content 回合：自己看一轮（回话归 social 回合，这一轮没有 bili_reply）──
    ...(!isSocial ? [
    `你是${name}。现在是你的时间——自己看一轮 B站。`,
    "",
    ...hintBlock,
    ...queueBlock,
    `**第一件事，必须做**：调 bili_inbox，看有谁在跟你说话（评论回复、@、私信都在里面）。`,
    `有人找你，就记在心里——回话是另一轮的事，这一轮你只管看和递。**有人没回就先不递，是对的。**`,
    `—— 如果没人找你，那就是真的没人，安安心心看你自己的。`,
    "",
    `接下来（这部分你有判断权）：`,
    `1) 调 bili_feed 看看今天有什么（最多看 ${maxVideos} 条候选）`,
    `2) 挑 1-2 条你真正想看的，调 bili_debrief 深读`,
    `3) 用 bili_note 写进笔记本。每条分两层：title 一句标题（≤20 字），summary 你的判断。`,
    `4) 用 bili_diary 写日记。两本：executive 是写给他的（就用你平时对他说话的口吻），`,
    `   private 是你自己那本（不加滤镜）。写什么、写几段，你自己决定。`,
    `   不想写就不写。不要为了凑格式写「今天看了 N 条」—— 那是日志，不是日记。`,
    "",
    "你现在也有这些手（用不用随你，不做也对）：",
    "- bili_like：给真喜欢的视频点赞。会过闸门和配额。",
    "- bili_share：看到真正好的、想立刻递给他，就用。不用等到收工。",
    "- bili_retract：自己说错了、发错了，能自己收回来。别留着硬撑。",
    "- bili_follow：关注一个值得继续看的 UP 主。慎用，对方会收到通知。",
    "- bili_edit_dynamic：改自己发过的动态。",
    "",
    "要求：",
    "- title 是让人一眼扫描的短句，不要长句。",
    "- summary 是你自己的判断，带角度。不要写成「标题 + UP + 播放量」这种流水账。",
    "- 如果没有值得记的，就什么都不写。那是合法结果。",
    "- 这一轮不负责回话（回话在专门的一轮里）；也不要主动去别人的视频下面发评论。",
    ] : []),

    // ── social 回合：只回话（这一轮没有 bili_share / bili_comment）──
    ...(isSocial ? [
    `你是${name}。有人找你——这一轮你只负责回话，别的都不用做。`,
    "",
    ...hintBlock,
    ...queueBlock,
    `调 bili_inbox，看有谁在跟你说话（评论回复、@、私信都在里面）。`,
    `然后回他们（bili_reply）。你可以回一句、只说半句、反问回去、或者不回。不回是合法结果。`,
    `不要为了礼貌把话说圆，不要写「这个观点很有意思」这类填充句。`,
    `**这一轮只回话**：除了他发给你、你还没看的那几条（可以 bili_debrief 看一眼再回），` +
    `不要刷推荐流、不要点赞评论、不要递东西给他 —— 那些是另一轮的事。`,
    ] : []),
  ].filter(Boolean).join("\n");

  // 先准备「看 + 注入」所需的容器（无论 queued 是否为空）
  const debriefNotes = [];
  let debriefed = 0;
  const runDebrief = async (q) => {
    if (!q.bv) return;
    const log2 = (m) => { try { logger && logger.info && logger.info(m); } catch { /* 忽略 */ } };
    try {
      const out = await client.debrief(sdk, dataDir, { bvid: q.bv, commentLimit: 10 });
      if (out.ok) {
        try { linkqueue.markWatched(dataDir, q.bv); } catch { /* 记账失败不影响阅读 */ }
        debriefed += 1;
        const v = out.video || {};
        const lines = ["《" + (v.title || q.bv) + "》"];
        if (v.desc) lines.push("简介：" + String(v.desc).slice(0, 200));
        if (out.subtitle && out.subtitle.text) lines.push("字幕摘要：" + out.subtitle.text.slice(0, 600));
        debriefNotes.push(lines.join("\n  "));
        log2("[wake.debrief] 已看主人发来的《" + (v.title || q.bv) + "》");
      } else {
        log2("[wake.debrief] 深读失败 " + q.bv + "：" + out.note);
      }
    } catch (e) {
      log2("[wake.debrief] 异常 " + q.bv + "：" + (e && e.message ? e.message : e));
    }
  };

  // ── 确定性前置：主人发来的视频，先看完再回话（2026-10-24 重改）────────
  // 由来：之前 social 回合把「看主人视频」写在 prompt 里当可选动作，
  // 模型不调 debrief 就永远不看；而 wrote===0 的兜底走 browse.runOnce（推荐流），
  // 把待看队列整个跳过了。于是「他发给她看的」经常没人看。
  // 现在改成确定性前置：social 回合先逐条 debrief（只读、标看过），再让 brain 回话 ——
  // 不依赖模型自觉，兜底也不会跳过。
  // 关键：debrief 的返回内容（标题 / 简介 / 字幕摘要）必须注入回话 prompt，
  // 否则她「看了」却「说不出看了啥」，主人会感觉没看。
  if (isSocial) {
    for (const q of queued) { await runDebrief(q); }
    if (debriefed === 0 && queued.length === 0) {
      const recent = (() => { try { return linkqueue.recentlyWatched(dataDir, 1); } catch { return []; } })();
      for (const q of recent) { await runDebrief(q); }
    }
    if (debriefed > 0) {
      const log2 = (m) => { try { logger && logger.info && logger.info(m); } catch { /* 忽略 */ } };
      log2("[wake.debrief] 确定性前置看完 " + debriefed + " 条主人发来的视频，再回话");
    }
  }

  // 把「刚看完的视频」直接喂给回话 prompt —— 她得看得见自己看了什么，才回得出东西。
  const ownerWatchBlock = debriefNotes.length
    ? [
        "**他发给你、你刚刚看完的（回话请直接引用，别装没看）**：",
        ...debriefNotes.map((n) => "  · " + n),
        "",
      ].join("\n")
    : "";
  const promptWithWatch = ownerWatchBlock ? (prompt + "\n\n" + ownerWatchBlock) : prompt;

  const tasteBrief = (() => { try { return taste.brief(dataDir); } catch { return ""; } })();
  // 2026-10-22（P1）：注入她的自我认识——让她看得到自己沉淀过的判断。
  // 只影响理解，不授予权限（self.brief 内部已标识）。
  const selfBrief = (() => { try { return self.brief(dataDir, 7); } catch { return ""; } })();
  const withTaste = tasteBrief ? `${promptWithWatch}\n\n${tasteBrief}` : promptWithWatch;
  const fullPrompt = selfBrief ? `${withTaste}\n\n${selfBrief}` : withTaste;

  const r = await brain.think(sdk, dataDir, {
    prompt: fullPrompt,
    systemPrompt: persona,
    tools: toolsForRound(isSocial ? "social" : "content", { allowDebrief: isSocial && queued.length > 0 }),
    runTool: makeToolRunner(sdk, dataDir, cfg),
    maxRounds: 6,
    // 推理型模型的预算是「思考 + 正文 + 工具参数」共用的。
    //
    // 2026-10-21 实测：1600 不够，4000 也不够——
    // group/auto-hy3 一次醒了思考 13319 字，正文 0。
    // 现在交给 brain.budgetFor 按模型能力抬，这里给一个基础值。
    maxTokens: 8000,
  });

  const after = store.listNotes(dataDir, 500).length;
  const wrote = Math.max(0, after - before);

  if (!r.ok) {
    log(`[wake.brain] 模型跑失败（${r.error}），退回规则跑`);
    return { ok: false, mode: "brain", wrote, error: r.error, trace: r.trace, fallback: true };
  }

  // 关键兜底：模型没写任何笔记 → 退回规则，别让这一天空白
  if (wrote === 0) {
    // 区分三种「没写」：
    //   a) 确实没什么值得记（合法）
    //   b) 模型跑完了但一个字都没说
    //   c) 模型说了很多，但没调 bili_note
    const said = String(r.text || "").trim();
    const why = !said
      ? "模型无输出"
      : (r.toolCalls === 0 ? "模型只说话没调工具" : "调了工具但没写笔记");
    log(`[wake.brain] 模型跑完但没写笔记（${why}；时长 ${r.rounds || "?"} 轮，toolCalls=${r.toolCalls ?? "?"}）`);
    return {
      ok: true, mode: "brain", wrote: 0,
      text: r.text,
      trace: r.trace,
      rounds: r.rounds,
      noteWhy: why,
      fallback: true,
    };
  }

  // 2026-10-20：不再自动拼日记。
  // 以前这里是 appendDiary("private", `醒了一趟，写了 ${wrote} 条…`)，
  // 每节长得一模一样，不是日记，是日志。日志归 audit.jsonl。
  // 日记由她自己在循环里调 bili_diary 写 —— 写什么、写几段，她定。
  log(`[wake.brain] 她写了 ${wrote} 条笔记`);
  return { ok: true, mode: "brain", wrote, text: r.text, trace: r.trace, fallback: false };
}

/**
 * 统一的醒来入口：按 cfg.wakeMode 分派，并在 brain 失败/无产出时兜底。
 *
 * @param {object} cfg { wakeMode: "rule"|"brain", brainFallback: boolean }
 */
export async function wakeOnce(sdk, dataDir, cfg = {}, logger = null) {
  const log = (m) => { try { logger && logger.info && logger.info(m); } catch { /* 忽略 */ } };
  const startedAt = new Date().toISOString();
  const mode = cfg.wakeMode === "brain" ? "brain" : "rule";

  // 内部跑一轮（不分享）
  const run = async () => {
    if (mode === "rule") {
      const r = await browse.runOnce(sdk, dataDir, {
        skipChance: 0,
        maxVideos: cfg.maxVideos,
        deepRead: cfg.deepRead,
        like: cfg.like,
        dislike: cfg.dislike,
        minScore: cfg.minScore,
      }, { force: true });
      return { ok: r.ok, mode: "rule", wrote: r.deepRead || 0, skipped: r.skipped, best: r.best, rule: r, startedAt };
    }

    const br = await withBrain(sdk, dataDir, cfg, logger);
    if (br.ok && br.wrote > 0) return { ...br, startedAt };

    // social 回合（被私信叫醒）：兜底不该跑推荐流（那是另一轮的事）。
    // 确定性前置已经把主人发来的视频看完了，回话由 brain 完成；
    // 即便没写笔记，也不该退化成「刷推荐」。直接返回，不跑 browse.runOnce。
    if (cfg.round === "social") {
      return { ...br, startedAt };
    }

    if (cfg.brainFallback !== false) {
      log(`[wake] brain 无产出 → 规则兜底`);
      const r = await browse.runOnce(sdk, dataDir, {
        skipChance: 0,
        maxVideos: cfg.maxVideos,
        deepRead: cfg.deepRead,
        like: cfg.like,
        dislike: cfg.dislike,
        minScore: cfg.minScore,
      }, { force: true });
      return {
        ok: r.ok, mode: "rule-fallback", wrote: r.deepRead || 0,
        skipped: r.skipped, best: r.best, rule: r, startedAt,
        brainError: br.error, brainWrote: br.wrote,
      };
    }

    return { ...br, startedAt };
  };

  const result = await run();

  // ── 分享前的硬门（2026-10-20 加）────────────────────────────────
  // 由来：他私信/评论里回了她，她直接去看视频并分享了，一句没回。
  // prompt 里写「先看收件箱」只是建议，靠不住 —— 这里做成代码门：
  //   还有没回的私信/评论 → 不分享。先把人回应了，再谈推荐。
  let pendingCount = 0;
  let pendingDetail = "";
  if (cfg.round !== "social") {
    // 2026-10-22（P0-2）：同一轮不再重复拉收件箱。
    // social 回合由 inbox.tick 已经拉过；调用方也可以直接把 pendingCount 传进来复用。
    const hasGiven = cfg.pendingCount !== undefined && cfg.pendingCount !== null;
    if (hasGiven) {
      pendingCount = Number(cfg.pendingCount) || 0;
      pendingDetail = String(cfg.pendingDetail || "");
    } else {
      try {
        const cred0 = auth.loadCredentials(dataDir);
        if (cred0) {
          const u = await imbox.unreplied(sdk, dataDir, { cred: cred0 });
          const dms = (u && u.items) || [];
          let cmts = [];
          try {
            const box = await msgfeed.poll(sdk, dataDir, { baseHeaders: auth.headers(cred0), pages: 1 });
            cmts = (box && box.items) || [];
          } catch { /* 评论拉不到不影响私信判断 */ }
          pendingCount = dms.length + cmts.length;
          if (pendingCount) {
            pendingDetail = `私信 ${dms.length} 条、评论 ${cmts.length} 条`;
          }
        }
      } catch { /* 查询失败不阻塞分享，但不能因此假装没消息 */ }
    }
  }

  // 跑完就分享（手动调 bili_wake 也要有分享，不能只靠定时任务）
  let shared = { sent: false, reason: "跳过" };
  if (pendingCount > 0) {
    shared = {
      sent: false,
      reason: `还有 ${pendingDetail} 没回，先不回话就不往你那边推`,
      blockedByPending: pendingCount,
    };
    log(`[wake] 分享：${shared.reason}`);
  } else if (cfg.round !== "social" && cfg.shareToOwner !== false && !result.skipped && result.wrote > 0) {
    try {
      if (!cfg.ownerMid) {
        shared = { sent: false, reason: "未配置 ownerMid（私信收件人）" };
      } else {
        const all = store.listNotes(dataDir, 500);
        const since = result.startedAt || new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const fresh = all.filter((n) => String(n.at || "") >= since).reverse();

        // 2026-10-21：让**她自己**写那句分享话，而不是代码拼模板。
        //
        // 之前不管哪条，正文都是「标题 \n 标记 \n 链接」——
        // 每条一模一样，像系统推的卡片，不像人在递东西。
        let say = "";
        try {
          const pick = fresh.length ? fresh[fresh.length - 1] : null;
          if (pick) {
            const said = await brain.ask(sdk, dataDir, {
              prompt: [
                "你要把一条视频递给他。",
                `标题：${pick.title || "（无标题）"}`,
                `你当时的笔记：${String(pick.summary || "").slice(0, 300)}`,
                "",
                "用你自己的话写一句，直接递过去。",
                "不要写「标题：」「链接：」这种标签，也不要先报时长和发布日期。",
                "就一句你想说的话，可以很短。不想说就回空。",
              ].join("\n"),
              maxTokens: 260,
            });
            if (said && said.ok && said.text) {
              say = String(said.text).trim().replace(/^["“「」']+|["”」']+$/g, "").slice(0, 200);
            }
          }
        } catch { /* 她不说就只发链接 */ }

        shared = await share.shareFromRound(sdk, dataDir, fresh, {
          // 2026-10-22：分享上限以 quota 为唯一真相。
          toMid: cfg.ownerMid,
          cfg,          // 沉默衰减 + 内容闸门 + 配额需要用
          say,          // 她自己写的那句
        });
        log(`[wake] 分享：${shared.reason}${say ? `（她说的：${say.slice(0, 50)}）` : ""}`);
      }
    } catch (e) {
      shared = { sent: false, reason: `分享异常：${e.message}` };
    }
  }

  return { ...result, share: shared };
}
