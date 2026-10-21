/**
 * lib/register-tools.js — 注册 bili_* 工具（P0）
 *
 * 工具是「她自己动手」的接口。闸门在工具内部强制，模型无法绕过：
 *   bili_gate 是预检；bili_publish 内部再跑一次 gate + quota（纵深三道：kill switch / 闸门 / 配额）。
 *
 * 调用约定：v2 单参调用，payload = { ...input, context }。这里统一从 payload 取业务字段。
 * P0：只读工具返回真实本地数据；联网/发布为桩，明确拒绝或返回未实装。
 */

import { readConfig } from "./config.js";
import { verifySession, hasCredentials, loadCredentials, headers as authHeaders } from "./auth.js";
import * as quota from "./quota.js";
import * as store from "./store.js";
import { evaluate } from "./gate.js";
import * as client from "./client.js";
import * as browse from "./browse.js";
import * as rhythm from "./rhythm.js";
import * as notify from "./notify.js";
import * as msgfeed from "./msgfeed.js";
import * as imbox from "./imbox.js";
import * as mycomments from "./mycomments.js";
import * as identity from "./identity.js";
import * as brain from "./brain.js";
import * as wake from "./wake.js";
import * as allowlist from "./allowlist.js";
import * as share from "./share.js";
import * as social from "./social.js";
import * as settings from "./settings.js";
import * as frames from "./frames.js";
import * as videoMeta from "./video-meta.js";
import * as dynamic from "./dynamic.js";
import * as likes from "./likes.js";
import * as reply from "./reply.js";
import * as retract from "./retract.js";
import * as taste from "./taste.js";
import * as feedback from "./feedback.js";
import * as silence from "./silence.js";
import { canShare } from "./silence.js";
import * as publish from "./publish.js";

/** 从 payload 取业务参数（剔除 host 注入的 context） */
function pick(payload) {
  if (!payload || typeof payload !== "object") return {};
  const { context, ...rest } = payload;
  return rest;
}

export async function registerTools(ctx, log) {
  const _log = log || wrapLogger(ctx && ctx.logger);
  const dataDir = ctx.dataDir || "";
  const offs = [];
  const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

  const register = async (tool) => {
    try {
      const off = await ctx.tools.register(tool);
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      _log.error(`工具注册失败 ${tool.name}：${e.message}`);
    }
  };

  // ── 体检 ─────────────────────────────────────────────────────────
  await register({
    name: "bili_health",
    description: "奥菲莉娅 B站 工作室体检：登录态是否配置、配额余量、配方状态。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const cfg = await readConfig(ctx);
      return text({
        stage: "P1",
        credentialsConfigured: hasCredentials(dataDir),
        session: await verifySession(ctx, dataDir),
        quota: quota.status(dataDir, cfg),
        autoPostEnabled: cfg.autoPostEnabled === true,
        note: "P1：自持登录态已接（真 nav 校验）。读内容走 bilibili_video_intake 工具；发布层仍为桩。",
      });
    },
  });

  // ── 读内容（P2：真实现，用她自己的号）──────────────────────────
  await register({
    name: "bili_feed",
    description: "拉 B站 个性化推荐流 / 搜索。只读。用她自己的登录态，所以推荐是个性化的。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "可选：搜索关键词；留空走个性化推荐流" },
        limit: { type: "number", description: "条数上限，默认 10（最大 30）" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const lim = Number(a.limit) > 0 ? Number(a.limit) : 10;
      const r = a.keyword
        ? await client.search(ctx, dataDir, { keyword: a.keyword, limit: lim })
        : await client.feed(ctx, dataDir, { limit: lim });
      return text(r);
    },
  });

  await register({
    name: "bili_debrief",
    description: "深读一条视频：详情 + 热评 + 字幕（只读）。",
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "BV 号" },
        commentLimit: { type: "number", description: "热评条数，默认 20" },
        visual: { type: "boolean", description: "true = 同时抽帧，真的看一眼画面（无字幕时强烈建议）" },
        substrip: { type: "boolean", description: "true = 把硬字幕裁成一条长图（没官方字幕轨的视频特别有用）" },
      },
      required: ["bv"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const r = await client.debrief(ctx, dataDir, {
        bvid: a.bv ?? "",
        commentLimit: Number(a.commentLimit) > 0 ? Number(a.commentLimit) : 20,
      });
      // 告诉模型「这条能不能看懂」：没字幕就该考虑看画面
      if (r.ok) {
        r.canUnderstand = Boolean(r.subtitle?.text);

        // 封面：一次 GET，成本最低；总是拿（UP 选的第一眼）
        try {
          const cv = await frames.cover(ctx, dataDir, { bvid: r.video?.bvid || a.bv, pic: r.video?.pic });
          if (cv.ok) {
            r.cover = cv.cover;
            // cover 是完整路径，笔记里只要文件名（/frame 会自己拼）
            r.coverName = String(cv.cover || "").split(/[\\/]/).pop() || "";
          }
        } catch { /* 封面失败不影响主流程 */ }

        // 真抽帧：只在她要求、且知道 cid 时做（下载+ffmpeg，有成本）
        if (a.visual === true) {
          const f = await frames.grab(ctx, dataDir, {
            ctx,                          // ← 必需：排 ffmpeg 要用宿主的 process 能力
            bvid: r.video?.bvid || a.bv,
            cid: r.video?.cid,
          });
          r.visual = f;
          if (f.ok) {
            r.canUnderstand = true;
            r.hint = `已抽帧：${f.note} 图片在 ${f.sheet}`;
          } else {
            r.hint = `抽帧失败：${f.error}${f.hint ? "｜" + f.hint : ""}`;
          }
        } else if (!r.canUnderstand) {
          r.hint = "无字幕，只能看到标题/简介/热评/弹幕统计。要真看画面就再调一次 visual:true，或 substrip:true 读硬字幕。";
        }

        // 硬字幕条：没字幕轨时最有用
        if (a.substrip === true) {
          const s = await frames.substrip(ctx, dataDir, {
            ctx,
            bvid: r.video?.bvid || a.bv,
            cid: r.video?.cid,
          });
          r.substripImg = s;
          if (s.ok) r.canUnderstand = true;
        }

        // 落一份元数据缓存 —— 写笔记时自动关联，不靠模型复制字段
        try {
          videoMeta.saveMeta(dataDir, r.video?.bvid || a.bv, r.video || {}, r.coverName || "");
        } catch { /* 缓存失败不影响主流程 */ }

        // 同时仍然告诉模型（它能传就传，不传也有兜底）
        r.noteHints = {
          source: r.video?.bvid || a.bv,
          bvid: r.video?.bvid || a.bv,
          cover: r.cover || "",
          duration: r.video?.duration || 0,
          pubdate: r.video?.pubdate || 0,
          up: r.video?.up || "",
          hint: "写 bili_note 时把这几个一起传，笔记里就有封面、时长和发布时间。",
        };
      }
      return text(r);
    },
  });

  // ── 该不该看画面（只给建议，不动手）────────────────────────
  await register({
    name: "bili_need_visual",
    description: "判断一条视频是否值得调抽帧看画面（无字幕 / 音乐MV / 以画面为主）。只给建议，不自己调 intake。",
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "BV 号" },
      },
      required: ["bv"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const d = await client.debrief(ctx, dataDir, { bvid: a.bv ?? "", commentLimit: 5 });
      if (!d.ok) return text({ ok: false, note: d.note });
      const v = d.video || {};
      const hasSub = Boolean(d.subtitle?.text);

      const reasons = [];
      // 没字幕 = 最大信号
      if (!hasSub) reasons.push("无字幕，文字路看不懂内容");
      // 音乐/MV 类：字幕往往只有歌词
      const t = `${v.title || ""} ${(v.tags || []).join(" ")}`;
      if (/MV|音乐|歌曲|翻唱|纯音乐|演奏|live|4K/i.test(t)) reasons.push("音乐/MV 类，画面是主体");
      // 短片 + 高弹幕：可能是反应/玩梗类，画面重要
      if (Number(v.duration) > 0 && Number(v.duration) <= 120) reasons.push("短视频，信息多在画面里");

      const need = reasons.length > 0;
      return text({
        ok: true,
        bvid: v.bvid,
        title: v.title,
        hasSubtitle: hasSub,
        duration: v.duration,
        recommendation: need ? "建议看画面" : "不必看画面",
        reasons,
        how: need
          ? "调 bilibili-intake 的 intake_shots（需先采集 + 开启「启用视觉帧分析」）。这是可选依赖；不装也能继续，只是看不懂画面。"
          : null,
      });
    },
  });

  // ── 观察笔记 ─────────────────────────────────────────────────────
  await register({
    name: "bili_note",
    description: "写一条观察笔记（她的笔记本）。写本地，不发布。title 是一句标题（≤24 字，可扫），summary 是她的判断（可长）。",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "来源（BV/链接/关键词）" },
        kind: { type: "string", description: "类型：video/comment/live/other" },
        title: { type: "string", description: "一句标题，≤20 字。例：「热评比正片更能说明问题」「免责声明在简介，结论在标题」" },
        summary: { type: "string", description: "你的判断。可以长，但要是自己的一句话，不要写成「标题+UP+播放量」流水账" },
        marks: { type: "array", items: { type: "string" }, description: "裂隙/情绪标记" },
        cover: { type: "string", description: "封面文件名（bili_debrief 会告诉你叫什么），可不传" },
        duration: { type: "number", description: "视频时长（秒）" },
        pubdate: { type: "number", description: "发布时间（unix 秒）" },
        up: { type: "string", description: "UP 主名字" },
        bvid: { type: "string", description: "BV 号" },
      },
      required: ["title", "summary"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      // 元数据自动补全：模型不传也能有封面/时长/UP/发布时间。
      // 实测两轮，noteHints 明明在 debrief 返回里，她 4 条笔记一次都没传 ——
      // 让模型「记得复制字段」是不可靠的设计。
      let enriched = videoMeta.enrichNote(dataDir, {
        source: a.source ?? "",
        kind: a.kind ?? "",
        title: a.title ?? "",
        summary: a.summary ?? "",
        marks: a.marks ?? [],
        cover: a.cover ?? "",
        duration: a.duration ?? 0,
        pubdate: a.pubdate ?? 0,
        up: a.up ?? "",
        bvid: a.bvid ?? "",
      });

      // 缓存里没有（她可能没深读就直接写笔记）→ 现查一次，最多多花 1 秒
      if (enriched.missingBv) {
        try {
          const m = await videoMeta.fetchAndSave(ctx, dataDir, enriched.missingBv);
          if (m) enriched = videoMeta.enrichNote(dataDir, enriched);
        } catch { /* 查不到就算了，不影响写笔记 */ }
      }
      delete enriched.missingBv;

      return text(store.addNote(dataDir, enriched));
    },
  });

  await register({
    name: "bili_notes",
    description: "列最近的观察笔记。只读。",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "默认 50" } },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      return text(store.listNotes(dataDir, Number(a.limit) > 0 ? Number(a.limit) : 50));
    },
  });

  // ── 草稿 ─────────────────────────────────────────────────────────
  await register({
    name: "bili_draft",
    description: "建一条草稿（动态/评论/私信），入草稿箱不直发。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "正文" },
        kind: { type: "string", enum: ["comment", "dynamic", "dm"], description: "类型" },
        targetBv: { type: "string", description: "目标 BV（评论时）" },
        via: { type: "string", enum: ["comment", "dm"], description: "分享通道" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      return text(store.addDraft(dataDir, {
        text: a.text ?? "", kind: a.kind ?? "comment", targetBv: a.targetBv ?? "", via: a.via ?? "comment",
      }));
    },
  });

  await register({
    name: "bili_drafts",
    description: "列草稿箱。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => text(store.listDrafts(dataDir)),
  });

  // ── 闸门预检（确定性）─────────────────────────────────────────────
  await register({
    name: "bili_gate",
    description: "对一段文本做发布前闸门预检：返回 ALLOW / HOLD / BLOCK 与理由。确定性规则，不交模型裁量。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "拟发布正文" },
        kind: { type: "string", enum: ["comment", "dynamic", "dm"] },
        targetBv: { type: "string" },
        newContentType: { type: "boolean", description: "是否首次尝试的新内容形态" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      return text(evaluate({ text: a.text ?? "", kind: a.kind ?? "comment", targetBv: a.targetBv ?? "" }, {
        newContentType: a.newContentType === true,
      }));
    },
  });

  // ── 发布（唯一写入口 · 纵深五道）────────────────────────────────
  await register({
    name: "bili_publish",
    description:
      "发布动态/评论/私信。内部强制五道：① kill switch；② 确定性闸门；③ 白名单+配额；④ 沉默衰减；⑤ 分享标尺。只在全部通过时才可能发出。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "正文" },
        kind: { type: "string", enum: ["comment", "dynamic", "dm"] },
        targetBv: { type: "string", description: "评论目标的 BV" },
        via: { type: "string", enum: ["comment", "dm"] },
        share: { type: "boolean", description: "是否分享型（会受沉默衰减与标尺约束）" },
        score: { type: "number", description: "标尺得分（0-20）。分享型必填，< minScore 不发" },
        reason: { type: "string", description: "分享型必填：为什么值得占用一次注意力（≥8 字）" },
      },
      required: ["text", "kind"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const draft = { text: a.text ?? "", kind: a.kind ?? "comment", targetBv: a.targetBv ?? "" };
      const isShare = a.share === true;
      const target = draft.targetBv ? `BV:${draft.targetBv}` : "";
      const block = (reason, extra = {}) => {
        store.audit(dataDir, { action: "publish", decision: "BLOCK", reason, kind: draft.kind, share: isShare, ...extra });
        return text({ ok: false, decision: "BLOCK", reason, ...extra });
      };

      // ① kill switch
      if (cfg.autoPostEnabled !== true) {
        return block("自主发布总开关关闭（kill switch）。只读模式。");
      }

      // ② 确定性闸门
      const g = evaluate(draft, { newContentType: a.kind === "dynamic" });
      if (g.decision !== "ALLOW") {
        if (g.decision === "HOLD") store.pushReview(dataDir, { draftId: "", text: draft.text, reasons: g.reasons });
        store.audit(dataDir, { action: "publish", decision: g.decision, reasons: g.reasons, kind: draft.kind });
        return text({ ok: false, decision: g.decision, reasons: g.reasons });
      }

      // ③ 白名单 + 配额（quota.check 内含 fail-closed）
      const q = quota.check(dataDir, { type: draft.kind, target, share: isShare, config: cfg });
      if (!q.ok) {
        const reason = q.corrupt ? q.reason : q.reason;
        return block(reason, { corrupt: Boolean(q.corrupt) });
      }

      // ④ 沉默衰减（只管分享，不管日记）
      if (isShare) {
        const sil = canShare(dataDir, cfg);
        if (!sil.ok) {
          return block(`沉默 ${sil.state.days} 天，分享额度降为 0（日记照写）`, { silence: sil.state });
        }
      }

      // ⑤ 分享标尺
      if (isShare) {
        const reason = String(a.reason ?? "").trim();
        if (reason.length < 8) return block(`分享型必须带 reason（为什么值得，≥ 8 字）`);
        const score = Number(a.score);
        if (!Number.isFinite(score) || String(a.score ?? "") === "") return block(`分享型必须带 score（0-20）`);
        if (score < cfg.minScore) {
          return block(`评分 ${score} < 阈值 ${cfg.minScore} → 这条不值得发（「今天没有值得发的」是合法结果）`, { score, threshold: cfg.minScore });
        }
      }

      store.audit(dataDir, { action: "publish", decision: "ALLOW", note: "五道全过，进入发布层", kind: draft.kind, share: isShare });

      // ⑤ 之后：真发或预演
      if (draft.kind === "comment") {
        if (!draft.targetBv) {
          return block("评论需要 targetBv");
        }
        // 拿 aid（评论接口要 oid）
        const info = await client.videoInfo(ctx, dataDir, { bvid: draft.targetBv });
        if (!info.ok) return block(`拿不到视频信息：${info.note}`);

        const r = await publish.publishComment(ctx, dataDir, {
          oid: info.video.aid,
          bvid: draft.targetBv,
          message: draft.text,
          live: cfg.publishLive === true,
        });
        return text({ ...r, gates: "五道全过" });
      }

      // 动态/私信：本版未实装
      if (draft.kind === "dynamic") {
        const r = await publish.publishDynamic(ctx, dataDir, {
          text: draft.text,
          live: cfg.publishLive === true,
        });
        return text({ ...r, gates: "五道全过" });
      }

      store.audit(dataDir, { action: "publish", decision: "ALLOW", note: `发布层未实装 ${draft.kind}`, kind: draft.kind });
      return text({
        ok: false, stage: "P5", decision: "ALLOW",
        note: `五道闸门全过，但 ${draft.kind} 发布层尚未实装（当前支持 comment / dynamic）。`,
      });
    },
  });

  // ── 人审 ─────────────────────────────────────────────────────────
  await register({
    name: "bili_review",
    description: "人审队列：列待拍板 / 批准 / 驳回。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "approve", "reject"], description: "操作" },
        id: { type: "string", description: "approve/reject 时的条目 id" },
        status: { type: "string", description: "list 过滤：pending/resolved/rejected" },
      },
      required: ["op"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      if (a.op === "list") return text(store.listReview(dataDir, a.status));
      if (!a.id) return text({ ok: false, reason: "需要 id" });
      const it = store.resolveReview(dataDir, a.id, a.op === "approve" ? "resolved" : "rejected");
      return text({ ok: Boolean(it), item: it });
    },
  });

  // ── 日记 ─────────────────────────────────────────────────────────
  await register({
    name: "bili_diary",
    description: "写两本日记：executive（给你的信）/ private（给她自己，不加滤镜）。",
    parameters: {
      type: "object",
      properties: {
        which: { type: "string", enum: ["executive", "private"] },
        text: { type: "string" },
      },
      required: ["which", "text"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const p = store.appendDiary(dataDir, a.which === "private" ? "private" : "executive", a.text ?? "");
      return text({ ok: true, file: p });
    },
  });

  // ── 配额 ─────────────────────────────────────────────────────────
  // ── 收件箱与已发（P8）─────────────────────────────────────────
  await register({
    name: "bili_inbox",
    description: "看有谁找过她（回复我的 / @我的）。拉收件箱，只看不回复。有新消息会写笔记 + 通知。",
    parameters: {
      type: "object",
      properties: {
        notify: { type: "boolean", description: "true = 有新消息时发通知（默认 true）" },
        markAllSeen: { type: "boolean", description: "true = 把水位推到最新（忽略历史）" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      if (a.markAllSeen === true) return text(msgfeed.markAllSeen(dataDir));

      const cred = loadCredentials(dataDir);
      if (!cred) return text({ ok: false, error: "未配置凭据" });
      const headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        referer: "https://www.bilibili.com/",
        cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? "; buvid3=" + cred.buvid3 : ""}`,
      };

      if (a.notify !== false) {
        const r = await msgfeed.pollAndNotify(ctx, dataDir, { baseHeaders: headers, pages: 1 });
        return text({
          ok: r.ok,
          fresh: (r.fresh || []).map((x) => ({ who: x.who, kind: x.kind, at: x.t, body: msgfeed.bodyOf(x).slice(0, 80) })),
          total: r.total,
          error: r.error,
          note: (r.fresh || []).length ? `新消息 ${r.fresh.length} 条` : "没有新消息",
        });
      }

      const r = await msgfeed.poll(ctx, dataDir, { baseHeaders: headers, pages: 1 });
      return text({
        ok: r.ok,
        items: (r.items || []).map((x) => ({ who: x.who, kind: x.kind, at: x.t, body: msgfeed.bodyOf(x).slice(0, 80) })),
        total: (r.items || []).length,
        errors: r.errors,
      });
    },
  });

  await register({
    name: "bili_edit_dynamic",
    description: "改一条已经发出去的动态。会把原有的图片原样带上（不会弄丢）。写通道，过闸门。",
    parameters: {
      type: "object",
      properties: {
        dynId: { type: "string", description: "动态 id" },
        text: { type: "string", description: "新正文（≤1000 字）" },
        live: { type: "boolean", description: "true = 真改；默认只预演" },
      },
      required: ["dynId", "text"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      // 真改需要两道都开：工具传 live + 全局 publishLive
      const live = a.live === true && cfg.publishLive === true;
      const r = await dynamic.editDynamic(ctx, dataDir, {
        dynId: a.dynId, text: a.text, cfg, live,
      });
      if (!live && a.live === true && cfg.publishLive !== true) {
        return text({ ...r, note: "（已预演）全局 publishLive 关着，真改需先在设置里开" });
      }
      return text(r);
    },
  });

  await register({
    name: "bili_dynamic_image",
    description: "发一条带图动态。图片先传到 B站 图床，再发 scene=2 的动态。写通道，过闸门，默认只预演。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "正文" },
        imagePath: { type: "string", description: "本地图片绝对路径（png/jpg）" },
        live: { type: "boolean", description: "true = 真发；默认只预演" },
      },
      required: ["text", "imagePath"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const live = a.live === true && cfg.publishLive === true;
      const r = await dynamic.publishDynamicImage(ctx, dataDir, {
        text: a.text, imagePath: a.imagePath, cfg, live,
      });
      if (!live && a.live === true && cfg.publishLive !== true) {
        return text({ ...r, note: "（已预演）全局 publishLive 关着，真发需先在设置里开" });
      }
      return text(r);
    },
  });

  await register({
    name: "bili_comment_digest",
    description: "把最近一段时间找过她的人汇成一份摘要（只读，一句都不回）。适合收工时给你看。正文会回读楼层核实，不用收件箱那个不可靠的 title。",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "number", description: "向前看几小时，默认 24" },
        pages: { type: "number", description: "翻几页收件箱，默认 2" },
        onlyUnread: { type: "boolean", description: "true = 只看未读（水位之后的）" },
        maxResolve: { type: "number", description: "最多回读多少条楼层，默认 12（多了就慢）" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const hours = Number(a.hours) > 0 ? Number(a.hours) : 24;
      const pages = Number(a.pages) > 0 ? Number(a.pages) : 2;
      const maxResolve = Number(a.maxResolve) > 0 ? Number(a.maxResolve) : 12;

      const cred = loadCredentials(dataDir);
      if (!cred) return text({ ok: false, error: "未配置凭据" });
      const headers = authHeaders(cred);

      const now = Math.floor(Date.now() / 1000);
      const since = now - hours * 3600;

      const got = await msgfeed.poll(ctx, dataDir, { baseHeaders: headers, pages });
      if (!got.ok && !(got.items || []).length) {
        return text({ ok: false, error: (got.errors || []).join("；") || "收件箱读不到" });
      }

      // 私信也算「找过她的人」
      let dms = [];
      try {
        const u = await imbox.unreplied(ctx, dataDir, { cred });
        dms = (u.items || []).map((x) => ({
          kind: "dm", who: x.name || `uid ${x.mid}`, mid: String(x.mid),
          body: x.text, t: x.at || 0,
        }));
      } catch { /* 私信读失败不影响评论 */ }

      let all = [
        ...(got.items || []).map((x) => ({ ...x, body: msgfeed.bodyOf(x) })),
        ...dms,
      ].filter((x) => !x.t || Number(x.t) >= since);

      if (a.onlyUnread === true) {
        const st = msgfeed.status(dataDir);
        const lv = Math.max(Number(st.replySeenAt || 0), Number(st.atSeenAt || 0));
        if (lv) all = all.filter((x) => Number(x.t) >= lv);
      }
      all.sort((x, y) => Number(x.t) - Number(y.t));

      // 回读楼层：收件箱 title 不可靠，同一楼同一人只查一次
      const cache = new Map();
      let resolved = 0;
      const out = [];
      for (const x of all) {
        let realBody = x.body;
        let exact = null;
        if ((!realBody || realBody.length < 4) && x.kind === "reply" && resolved < maxResolve) {
          const key = `${x.oid}|${x.root}|${x.mid}`;
          if (!cache.has(key)) {
            resolved += 1;
            try {
              const r = await msgfeed.resolveReply(ctx, {
                business: x.business || 1, oid: x.oid, root: x.root,
                mid: x.mid, parentRpid: x.parent, headers,
              });
              cache.set(key, r ? { text: r.text, rpid: r.rpid, exact: r.exact } : null);
            } catch { cache.set(key, null); }
          }
          const hit = cache.get(key);
          if (hit && hit.text) { realBody = hit.text; exact = hit.exact; }
        }
        out.push({
          kind: x.kind === "dm" ? "私信" : (x.kind === "at" ? "@我" : "回复"),
          who: x.who,
          mid: x.mid,
          at: Number(x.t) || 0,
          body: String(realBody || "（读不到正文）").slice(0, 200),
          resolved: exact === null ? null : exact,
        });
      }

      // 谁话最多
      const byWho = new Map();
      for (const x of out) byWho.set(x.who, (byWho.get(x.who) || 0) + 1);
      const multi = [...byWho.entries()].filter(([, n]) => n > 1).map(([w, n]) => `${w}（${n} 条）`);

      return text({
        ok: true,
        hours,
        total: out.length,
        resolvedCount: resolved,
        items: out,
        talkative: multi,
        note: out.length ? `最近 ${hours} 小时有 ${out.length} 条` : `最近 ${hours} 小时没人找`,
      });
    },
  });

  await register({
    name: "bili_my_comments",
    description: "看她自己发过什么（本地账 + 空间回读）。只读。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "条数上限，默认 50" },
        mid: { type: "string", description: "她的 mid（可选，用于空间回读）" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const sel = identity.readSelection(dataDir);
      const mid = a.mid || sel.agentId || "";
      const r = await mycomments.list(ctx, dataDir, { mid, limit: Number(a.limit) > 0 ? Number(a.limit) : 50 });
      return text(r);
    },
  });

  // ── 脑子（P9）────────────────────────────────────────────
  await register({
    name: "bili_think",
    description: "用她自己的脑子想一件事（App 自己调模型，不建会话、不占主界面）。可带工具循环。只用于验证与调试。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "要她想的问题" },
        withTools: { type: "boolean", description: "true = 允许她调 bili_feed / bili_debrief 等只读工具" },
        maxRounds: { type: "number", description: "工具循环上限，默认 3" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const useTools = a.withTools === true;

      if (!useTools) {
        const r = await brain.ask(ctx, dataDir, { prompt: a.prompt });
        return text(r);
      }

      // 带工具：只暴露只读工具，写入口绝不给模型自己调
      const tools = [
        { name: "bili_feed", description: "拉 B站 推荐流或搜索。只读。", parameters: { type: "object", properties: { keyword: { type: "string" }, limit: { type: "number" } } } },
        { name: "bili_debrief", description: "深读一条视频（详情+热评+字幕+弹幕）。只读。", parameters: { type: "object", properties: { bv: { type: "string" } }, required: ["bv"] } },
        { name: "bili_note", description: "写一条观察笔记。写本地。", parameters: { type: "object", properties: { summary: { type: "string" }, source: { type: "string" }, kind: { type: "string" }, marks: { type: "array", items: { type: "string" } } }, required: ["summary"] } },
      ];

      const r = await brain.think(ctx, dataDir, {
        prompt: a.prompt,
        tools,
        maxRounds: Number(a.maxRounds) > 0 ? Number(a.maxRounds) : 5,
        runTool: async (name, args) => {
          if (name === "bili_feed") {
            const lim = Number(args.limit) > 0 ? Number(args.limit) : 5;
            const out = args.keyword
              ? await client.search(ctx, dataDir, { keyword: args.keyword, limit: lim })
              : await client.feed(ctx, dataDir, { limit: lim });
            return JSON.stringify(out).slice(0, 3000);
          }
          if (name === "bili_debrief") {
            const out = await client.debrief(ctx, dataDir, { bvid: args.bv || "", commentLimit: 10 });
            // 只给模型看有用的，不塞大块原始 JSON
            if (!out.ok) return `失败：${out.note}`;
            const v = out.video || {};
            const lines = [];
            lines.push(`《${v.title}》 UP ${v.up} | ${v.duration}秒 | ${v.view}播放`);
            if (v.desc) lines.push(`简介：${String(v.desc).slice(0, 200)}`);
            if (out.subtitle?.text) lines.push(`字幕：${out.subtitle.text.slice(0, 800)}`);
            if (out.danmaku?.hotMoments?.length) {
              lines.push(`弹幕热区：${out.danmaku.hotMoments.map((h) => `${h.at}s ${h.count}条`).join(" / ")}`);
            }
            if (out.comments?.length) lines.push(`热评：${out.comments.slice(0, 3).map((c) => c.content).join(" | ")}`);
            return lines.join("\n");
          }
          if (name === "bili_note") {
            const n = store.addNote(dataDir, {
              summary: args.summary || "", source: args.source || "",
              kind: args.kind || "other", marks: args.marks || [],
            });
            return `已写入笔记 ${n.id}`;
          }
          return `未知工具：${name}`;
        },
      });
      return text(r);
    },
  });

  await register({
    name: "bili_brain_status",
    description: "看她用的是什么模型、人格多长。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const m = await brain.pickModel(ctx, dataDir);
      const sel = identity.readSelection(dataDir);
      const personaRes = await identity.resolvePersona(ctx, dataDir, sel.agentId || "");
      const persona = personaRes.persona;
      return text({
        model: m,
        agent: { id: sel.agentId || null, name: sel.agentName || null },
        personaLength: persona.length,
        personaPreview: persona.slice(0, 120),
        personaSource: personaRes.source,
      });
    },
  });

  await register({
    name: "bili_wake",
    description: "叫她醒一轮（手动触发）。按 wakeMode 跑：rule 纯规则 / brain 她自己用模型想。可选临时覆盖模式。",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["rule", "brain"], description: "临时覆盖 wakeMode" },
        force: { type: "boolean", description: "true = 忽略「今天不看」的概率" },
        ignoreQuota: { type: "boolean", description: "true = 就算到今日上限也强行醒（会记账）" },
        background: { type: "boolean", description: "true = 不等待。brain 模式跑一轮可能 60+ 秒，超过宿主工具 RPC 的 30 秒窗口会被拦腰截断（App invocation expired）。后台执行完会自己记账。" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const useMode = a.mode === "brain" ? "brain" : (a.mode === "rule" ? "rule" : cfg.wakeMode);

      // 手动唤醒也要计入每日上限——否则这个闸门只对定时任务有效，对工具无效
      const st0 = rhythm.status(dataDir);
      const cap = Number(cfg.maxWakesPerDay) > 0 ? Number(cfg.maxWakesPerDay) : 3;
      if (Number(st0.wakes || 0) >= cap && a.ignoreQuota !== true) {
        return text({
          ok: false, blocked: true,
          reason: `今日已醒 ${st0.wakes}/${cap} 次，到上限了。真要再叫一次就传 ignoreQuota:true`,
          wakes: st0.wakes, cap,
        });
      }
      // 绕过配额要留痕：否则界面上只会看到「5/3」这种看不懂的数字
      if (Number(st0.wakes || 0) >= cap && a.ignoreQuota === true) {
        store.audit(dataDir, {
          action: "wake",
          decision: "OVERRIDE",
          reason: `手动绕过配额（已醒 ${st0.wakes}/${cap}）`,
        });
      }

      if (a.force === true) {
        cfg.skipChance = 0;
      }

      const wakeArgs = {
        wakeMode: useMode,
        brainFallback: cfg.brainFallback,
        skipChance: a.force === true ? 0 : cfg.skipChance,
        maxVideos: cfg.maxVideos,
        deepRead: cfg.deepRead,
        like: cfg.like,
        dislike: cfg.dislike,
        minScore: cfg.minScore,
        shareToOwner: cfg.shareToOwner,
        shareMaxPerDay: cfg.shareMaxPerDay,
        ownerMid: cfg.ownerMid,   // 没这个就不知道私信发给谁
      };

      // 后台模式：宿主给 App 工具回调的窗口是 30 秒，
      // 而 brain 模式要跑 4~6 轮模型（实测 30~60 秒），必然被截断。
      // 实测报错：App invocation expired or belongs to another App。
      // 所以长任务扔给 tasks 跑，工具立即返回。
      if (a.background === true) {
        // 关键（2026-10-20 实测）：光是不 await 没用。
        // 整个 execute 仍然跑在「已被标记为过期」的工具调用上下文里，
        // ctx.models.stream 同样走 RPC，所以第 2 轮就报 App invocation expired。
        //
        // 正确做法：写一个请求文件 + 排 3 秒后的一次性任务。
        // 真正干活在 wake.manual 的 handler 里（用 App 长生命周期的 sdk）。
        const fsMod = await import("node:fs");
        const pathMod = await import("node:path");
        fsMod.writeFileSync(
          pathMod.join(dataDir, "wake-request.json"),
          JSON.stringify({ mode: useMode, force: a.force === true, at: Date.now() })
        );

        const runAt = Date.now() + 3000;
        await ctx.tasks.schedule({
          handlerKey: "wake.manual",
          runAt,
          label: "陪看 · 手动叫醒（后台）",
          enabled: true,
        });

        return text({
          ok: true,
          background: true,
          runAt: new Date(runAt).toISOString(),
          message: "已排一个 3 秒后的后台任务（跑在宿主任务上下文里，不受工具 30 秒限制）。看日志里 [wake.bg] 那行就知道结果。",
          mode: useMode,
        });
      }

      const r = await wake.wakeOnce(ctx, dataDir, wakeArgs, sdkLogger(ctx));
      // 记一次醒来（手动也要记，否则侧边栏那个 1/3 永远不动）
      let plan = null;
      try { plan = rhythm.markWoke(dataDir, cfg); } catch { /* 记账失败不影响结果 */ }

      return text({
        ok: r.ok,
        mode: r.mode,
        wrote: r.wrote,
        skipped: r.skipped || false,
        fallback: r.fallback || false,
        brainError: r.brainError || null,
        // 没写笔记时，告诉她为什么（模型无输出 / 只说话 / 调了工具但没写）
        noteWhy: r.noteWhy || null,
        rounds: r.rounds,
        text: r.text ? String(r.text).slice(0, 800) : null,
        trace: r.trace ? r.trace.map((t) => ({ r: t.round, tool: t.tool, ok: !t.isError, args: t.args ? JSON.stringify(t.args).slice(0, 160) : null })) : null,
        share: r.share || null,   // 手动唤醒也必须能分享
        wakes: plan ? plan.wakes : undefined,
        nextWake: plan ? plan.plan : undefined,
      });
    },
  });

  await register({
    name: "bili_allowlist",
    description: "看白名单状态：静态条目 + 动态名单（谁找过她）。可清空已知名单。",
    parameters: {
      type: "object",
      properties: {
        forget: { type: "boolean", description: "true = 清空「谁找过她」的名单" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      if (a.forget === true) return text(allowlist.forgetPeople(dataDir));
      return text(allowlist.describe(cfg.scope, dataDir));
    },
  });

  await register({
    name: "bili_share",
    description: "把她看过的东西递给你（B站 私信 + BV 链接；私信不可用时退回系统通知）。默认从最近笔记里挑一条；也可指定 bv。",
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "指定 BV；不传则从最近笔记里挑" },
        maxPerDay: { type: "number", description: "今日上限，默认 10" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const notes = store.listNotes(dataDir, 20).reverse();
      const maxPerDay = Number(a.maxPerDay) > 0 ? Number(a.maxPerDay) : (Number(cfg.shareMaxPerDay) || 10);
      // 收件人必须从配置里取 —— 之前没传 toMid，私信永远失败，
      // 结果每次都退回系统通知（明明互关了却发不出去）。
      const toMid = String(cfg.ownerMid || "");

      if (a.bv) {
        const hit = notes.find((n) => String(n.source || "").includes(a.bv) || String(n.summary || "").includes(a.bv));
        if (!hit) return text({ sent: false, reason: `最近笔记里没有 ${a.bv}` });
        return text(await share.shareNote(ctx, dataDir, hit, { maxPerDay, toMid, cfg }));
      }
      return text(await share.shareFromRound(ctx, dataDir, notes, { maxPerDay, toMid, cfg }));
    },
  });

  await register({
    name: "bili_share_status",
    description: "看今天推了几条、推过哪些 BV。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => text(share.status(dataDir)),
  });

  // ── 关注 / 私信（P13，都走闸门）────────────────────────────────
  await register({
    name: "bili_follow",
    description: "关注一个人（对外可见的社交动作，会过闸门）。默认预演。不受 publishLive 限制（关注是点对点，不是公开发言）。",
    parameters: {
      type: "object",
      properties: {
        mid: { type: "string", description: "要关注的人 mid" },
        live: { type: "boolean", description: "true = 真关注（需 kill switch 开 且 白名单放行）" },
      },
      required: ["mid"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const target = `uid:${a.mid}`;

      // 闸门：点对点开关（与公开发言分开）
      if (cfg.socialEnabled !== true) {
        store.audit(dataDir, { action: "follow", decision: "BLOCK", reason: "socialEnabled=false", mid: String(a.mid) });
        return text({ ok: false, blocked: true, reason: "点对点开关未开（socialEnabled）→ 不关注任何人" });
      }
      // 闸门：白名单
      const al = allowlist.allows({ scope: cfg.scope, target, dataDir });
      if (!al.allowed) {
        store.audit(dataDir, { action: "follow", decision: "BLOCK", reason: al.reason, mid: String(a.mid) });
        return text({ ok: false, blocked: true, reason: al.reason });
      }
      // 闸门：频率（复用配额 log 里的 follow 记录）
      const q = quota.check(dataDir, { type: "follow", target, config: { ...cfg, quota: { ...cfg.quota, follow: 3 } } });
      if (!q.ok) return text({ ok: false, blocked: true, reason: q.reason });

      const r = await social.follow(ctx, dataDir, { mid: a.mid, live: a.live === true });
      if (r.ok && r.mode === "live") quota.record(dataDir, { type: "follow", target, note: `关注 ${a.mid}` });
      return text(r);
    },
  });

  await register({
    name: "bili_dm",
    description: "发私信（风控最凶的接口，仅限互关的 owner）。闸门 + 互关校验。默认预演。不受 publishLive 限制（私信是点对点）。",
    parameters: {
      type: "object",
      properties: {
        toMid: { type: "string", description: "收信人 mid（必须是白名单里的 owner）" },
        text: { type: "string", description: "正文" },
        live: { type: "boolean", description: "true = 真发" },
      },
      required: ["toMid", "text"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const target = `uid:${a.toMid}`;
      const block = (reason) => {
        store.audit(dataDir, { action: "dm", decision: "BLOCK", reason, toMid: String(a.toMid) });
        return text({ ok: false, blocked: true, reason });
      };

      if (cfg.socialEnabled !== true) return block("点对点开关未开（socialEnabled）");

      const al = allowlist.allows({ scope: cfg.scope, target, dataDir });
      if (!al.allowed) return block(al.reason);

      const q = quota.check(dataDir, { type: "dm", target, config: cfg });
      if (!q.ok) return block(q.reason);

      const r = await social.sendDm(ctx, dataDir, {
        toMid: a.toMid, text: a.text,
        live: a.live === true,
      });
      if (r.ok && r.mode === "live") quota.record(dataDir, { type: "dm", target, note: String(a.text).slice(0, 40) });
      return text(r);
    },
  });

  await register({
    name: "bili_relation",
    description: "查她和某个人的关系（是否互关）。只读。",
    parameters: {
      type: "object",
      properties: { mid: { type: "string", description: "对方 mid" } },
      required: ["mid"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cred2 = loadCredentials(dataDir);
      if (!cred2) return text({ ok: false, error: "未配置凭据" });
      return text(await social.relation(ctx, cred2, a.mid));
    },
  });

  // ── 点赞（P16）──────────────────────────────────────────────
  await register({
    name: "bili_like",
    description: "给一条视频点赞（最轻的对外动作，但仍过闸门）。默认预演。",
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "BV 号" },
        live: { type: "boolean", description: "true = 真赞" },
      },
      required: ["bv"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const r = await likes.give(ctx, dataDir, { bvid: a.bv, live: a.live === true, config: cfg });
      if (r.ok && r.mode === "live") {
        try { likes.remember(dataDir, { bvid: a.bv, note: r.note }); } catch { /* 忽略 */ }
      }
      return text(r);
    },
  });

  await register({
    name: "bili_unlike",
    description: "取消赞。默认预演。",
    parameters: {
      type: "object",
      properties: {
        bv: { type: "string", description: "BV 号" },
        live: { type: "boolean", description: "true = 真取消" },
      },
      required: ["bv"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      return text(await likes.cancel(ctx, dataDir, { bvid: a.bv, live: a.live === true, config: cfg }));
    },
  });

  await register({
    name: "bili_likes_received",
    description: "谁赞了她（只读）。主人赞了哪条 = 最干净的偏好信号。",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "number", description: "回溯小时数，默认 24" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      return text(await likes.received(ctx, dataDir, {
        hours: Number(a.hours) > 0 ? Number(a.hours) : 24,
        ownerMid: cfg.ownerMid,
      }));
    },
  });

  // ── 回复（P18：C 档 — 她决定说什么，闸门决定发不发）
  await register({
    name: "bili_reply_to",
    description: "回一条找你的人。需先知道收件箱那条的 id（用 bili_inbox 拿）。默认预演。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "收件箱里那条的 id" },
        text: { type: "string", description: "回什么" },
        live: { type: "boolean", description: "true = 真发" },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const cred = loadCredentials(dataDir);
      if (!cred) return text({ ok: false, error: "没有凭据" });

      const box = await msgfeed.poll(ctx, dataDir, { baseHeaders: authHeaders(cred), pages: 1 });
      const item = (box.items || []).find((x) => String(x.id) === String(a.to));
      if (!item) return text({ ok: false, error: `收件箱里找不到 id=${a.to}` });

      const r = await reply.replyTo(ctx, dataDir, cfg, {
        item,
        text: a.text,
        live: a.live === true,
      });
      return text(r);
    },
  });

  await register({
    name: "bili_pending",
    description: "待拍板的回复：列 / 批准 / 驳回。批准才会真发。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "approve", "reject"], description: "动作" },
        id: { type: "string", description: "approve/reject 时要的 id" },
        why: { type: "string", description: "驳回原因（会记录，供以后学分寸）" },
      },
      required: ["op"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      if (a.op === "list") return text({ ok: true, items: reply.pending(dataDir, "pending") });
      if (a.op === "approve") {
        if (!a.id) return text({ ok: false, error: "缺 id" });
        return text(await reply.approve(ctx, dataDir, cfg, a.id));
      }
      if (a.op === "reject") {
        if (!a.id) return text({ ok: false, error: "缺 id" });
        return text(reply.reject(dataDir, a.id, a.why || ""));
      }
      return text({ ok: false, error: "未知 op" });
    },
  });

  // ── 口味（P20/P21）────────────────────────────────────────
  await register({
    name: "bili_taste",
    description: "看/改她的口味档案。她的判断和主人的反馈各占一份权重。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["show", "touch"], description: "show = 看；touch = 记一笔" },
        trait: { type: "string", description: "主题词（touch 时用），如「时政」「猫咪」" },
        side: { type: "string", enum: ["mine", "owner"], description: "谁的态度" },
        delta: { type: "number", description: "+1 喜欢 / -1 不喜欢" },
        note: { type: "string", description: "一句说明" },
      },
      required: ["op"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      if (a.op === "show") return text(taste.snapshot(dataDir));
      if (a.op === "touch") {
        if (!a.trait) return text({ ok: false, error: "缺 trait" });
        return text(taste.touch(dataDir, a.trait, {
          side: a.side === "owner" ? "owner" : "mine",
          delta: Number(a.delta) || 0,
          note: a.note || "",
        }));
      }
      return text({ ok: false, error: "未知 op" });
    },
  });

  await register({
    name: "bili_feedback",
    description: "从主人一句话里读出对某类内容的态度，落进口味档案（语义判断，非关键词）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "主人说的话" },
        context: { type: "string", description: "上下文（之前聊了什么）" },
        who: { type: "string", enum: ["owner", "mine"], description: "默认 owner" },
        candidates: { type: "string", description: "可选：额外候选主题词，逗号分隔" },
        debug: { type: "boolean", description: "true = 回显实际 prompt（排查用）" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      // 候选主题词：让模型做选择题，而不是凭空想
      const cands = (() => { try { return feedback.candidatesFrom(dataDir, cfg); } catch { return []; } })();
      const extra = a.candidates ? String(a.candidates).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
      return text(await feedback.digest(ctx, dataDir, {
        text: a.text,
        context: a.context || "",
        who: a.who === "mine" ? "mine" : "owner",
        candidates: [...new Set([...extra, ...cands])],
        debug: a.debug === true,
      }));
    },
  });

  // ── 收回（P22）──────────────────────────────────────────────
  await register({
    name: "bili_retract",
    description: "删掉她自己发过的评论或动态。只删审计里记过「她发的」，删不了别人的。默认预演。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["comment", "dynamic"], description: "删什么" },
        rpid: { type: "string", description: "评论 id（kind=comment 时必填）" },
        dynId: { type: "string", description: "动态 id（kind=dynamic 时必填）" },
        bvid: { type: "string", description: "评论所在视频的 BV（可选，帮助定位 aid）" },
        live: { type: "boolean", description: "true = 真删" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      if (a.kind === "dynamic") {
        return text(await retract.dynamic(ctx, dataDir, { dynId: a.dynId, live: a.live === true, config: cfg }));
      }
      return text(await retract.comment(ctx, dataDir, {
        rpid: a.rpid, bvid: a.bvid || "", live: a.live === true, config: cfg,
      }));
    },
  });

  await register({
    name: "bili_sent",
    description: "列她发过、还没删的评论和动态。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => text(retract.sentList(dataDir)),
  });

  // ── 调试探针（合并成一个）────────────────────────────────
  //
  // 以前这里摆了 7 个独立工具：bili_caps / bili_fs / bili_ref / bili_raw /
  // bili_read_agent / bili_model_test / bili_models。
  // 它们不是她过日子的能力，是我排障时造的探针，却一直占着工具表。
  // 现在收成一个 bili_debug，用 what 分派；她平时看到不到它（不在 wake 的 TOOLS 里）。
  await register({
    name: "bili_debug",
    description: "排障探针（不参与日常）。what=agent 助手文件 / models 模型清单 / model-test 试模型。",
    parameters: {
      type: "object",
      properties: {
        what: {
          type: "string",
          enum: ["agent", "models", "model-test"],
          description: "探哪个",
        },
        agentId: { type: "string", description: "agent 用，默认 ophelia" },
        provider: { type: "string", description: "model-test 用" },
        model: { type: "string", description: "model-test 用" },
        withPersona: { type: "boolean", description: "model-test 用，默认 true" },
        prompt: { type: "string", description: "model-test 用" },
      },
      required: ["what"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const what = String(a.what || "");
      const aid = String(a.agentId || "ophelia");

      if (what === "agent") return text(await identity.readAgentFiles(ctx, aid));

      if (what === "models") {
        return text({
          picked: await brain.pickModel(ctx, dataDir).catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) })),
          list: await (async () => {
            try {
              const list = ctx?.models?.list;
              if (typeof list !== "function") return [];
              const r = await list.call(ctx.models);
              return (r?.models || []).map((x) => ({
                id: x.id || x.model || "",
                provider: x.provider || "",
                isCurrent: Boolean(x.isCurrent),
                contextWindow: x.contextWindow || null,
                maxTokens: x.maxTokens || null,
              }));
            } catch { return []; }
          })(),
        });
      }

      if (what === "model-test") {
        const t0 = Date.now();
        const p = String(a.prompt || "说一句话证明你在。");
        const sys = a.withPersona === false
          ? ""
          : (await identity.resolvePersona(ctx, dataDir, (identity.readSelection(dataDir) || {}).agentId || "")).persona;
        const r = await brain.ask(ctx, dataDir, {
          prompt: p, systemPrompt: sys, maxTokens: 3000,
          override: { provider: a.provider, model: a.model },
        });
        return text({
          ok: Boolean(r && r.ok), ms: Date.now() - t0,
          tried: { provider: a.provider, model: a.model }, sysLen: sys.length,
          text: r && r.text ? String(r.text).slice(0, 500) : null,
          error: r && r.error ? String(r.error).slice(0, 500) : null,
          seen: r && r.seen ? r.seen : null,
          usage: r && r.usage ? r.usage : null,
        });
      }

      return text({ ok: false, error: "what 不认识：" + what });
    },
  });

  // ── 权限探测（临时，验证完可删）────────────────────────────
  

  

  

  

  

  

  

  // ── 配置读写（P14）─────────────────────────────────────────
  await register({
    name: "bili_set",
    description: "直接改 App 配置（不用你去设置页点）。只接受白名单内的键；危险开关会在返回里明确警告。",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "object",
          description: "要改的键值对，例 {\"socialEnabled\": true, \"scope\": \"reply-to-me,uid:12345678\"}",
          additionalProperties: true,
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const r = await settings.apply(ctx, a.patch || {});
      return text(r);
    },
  });

  await register({
    name: "bili_settings",
    description: "读当前可写配置的值（安全开关 / 作息 / 白名单 / 口味）。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => text(await settings.snapshot(ctx)),
  });

  await register({
    name: "bili_quota",
    description: "查配额余量（每日/同目标）。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => { const cfg2 = await readConfig(ctx); return text(quota.status(dataDir, cfg2)); },
  });

  // ── 浏览控制 ───────────────────────────────────────────────────
  await register({
    name: "bili_browse",
    description: "跑一轮浏览：拉流 → 挑值得的 → 深读 → 写观察笔记。只读，不发布。",
    parameters: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "true 时忽略「今天不想看」，强制看一轮" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      const r = await browse.runOnce(ctx, dataDir, {
        skipChance: cfg.skipChance,
        maxVideos: cfg.maxVideos,
        deepRead: cfg.deepRead,
      }, { force: a.force === true });
      return text(r);
    },
  });

  await register({
    name: "bili_browse_status",
    description: "看浏览状态：上次醒来、醒来次数、看过多少条、当前计划。只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => text(browse.status(dataDir)),
  });

  // ── 生物钟控制 ─────────────────────────────────────────────────
  await register({
    name: "bili_rhythm",
    description: "看/重算生物钟：status 看今天的窗口与计划；replan 立即按新逻辑重算并重排（修旧排程用）。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["status", "replan"], description: "操作" },
      },
      required: ["op"],
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      if (a.op === "status") {
        return text({
          ...rhythm.status(dataDir),
          windows: rhythm.parseWindows(cfg.nightWindows),
          maxWakesPerDay: cfg.maxWakesPerDay,
          skipChance: cfg.skipChance,
        });
      }
      // replan：算新计划 + 清旧排程 + 重排
      const plan = rhythm.planAndSave(dataDir, cfg);

      // 清掉旧的 rhythm.wake 排程
      let cleared = 0;
      try {
        const list = typeof ctx.tasks.listSchedules === "function" ? await ctx.tasks.listSchedules() : [];
        for (const s of (Array.isArray(list) ? list : [])) {
          if (s.handlerKey === "rhythm.wake") {
            await ctx.tasks.unschedule(s.scheduleId);
            cleared++;
          }
        }
      } catch (e) { /* 忽略 */ }

      // 重排新计划
      let scheduledAt = null;
      try {
        const ts = rhythm.planToTimestamp(plan);
        const runAt = ts && ts > Date.now() ? ts : rhythm.tomorrowFirstWindowTs(cfg);
        await ctx.tasks.schedule({
          handlerKey: "rhythm.wake",
          runAt,
          label: `奥菲莉娅 · 醒（${new Date(runAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}）`,
          enabled: true,
        });
        scheduledAt = new Date(runAt).toISOString();
      } catch (e) { /* 忽略 */ }

      return text({
        ok: true, plan,
        clearedOld: cleared,
        scheduledAt,
        note: scheduledAt ? `已清 ${cleared} 个旧排程，重排到 ${new Date(scheduledAt).toLocaleString("zh-CN")}` : "计划已落盘，但重排失败（看日志）",
      });
    },
  });

  await register({
    name: "bili_silence",
    description: "看沉默衰减状态：多久没收到表态、当前分享额度、处于什么阶段。记一笔表态用 mark=true。",
    parameters: {
      type: "object",
      properties: {
        mark: { type: "boolean", description: "true = 记一次表态（重置沉默计时）" },
        note: { type: "string", description: "这次表态的来源，例：回了评论 / 点了个赞" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const cfg = await readConfig(ctx);
      if (a.mark === true) {
        const last = silence.markFeedback(dataDir, a.note || "表态");
        return text({ ok: true, marked: last, state: silence.silenceState(dataDir, cfg) });
      }
      return text(silence.silenceState(dataDir, cfg));
    },
  });

  // ── 通知自测（真正走 notifications.show，用于验证通道）────────
  await register({
    name: "bili_notify_test",
    description: "发一条测试通知，验证宿主通知通道是否可用。只用于排障，不参与日常流程。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "标题，默认「奥菲莉娅 · 测试」" },
        body: { type: "string", description: "正文" },
      },
      additionalProperties: false,
    },
    execute: async (payload) => {
      const a = pick(payload);
      const r = await notify.push(ctx, dataDir, {
        title: a.title || "奥菲莉娅 · 测试",
        body: a.body || "通知通道正常。看到这条就说明她能找到你了。",
      });
      return text(r);
    },
  });

  return () => {
    for (const off of offs) { try { off(); } catch { /* teardown */ } }
  };
}

/** v2 logger 返回 Promise 且只打 format；包一层 v1 风格的调用即忘。 */
function wrapLogger(logger) {
  const call = (level) => (msg, ...rest) => {
    try {
      const fn = logger && logger[level];
      if (typeof fn !== "function") return;
      const text = rest.length ? `${msg} ${rest.map(safeStr).join(" ")}` : String(msg);
      const r = fn.call(logger, text);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* 日志失败不影响业务 */ }
  };
  return { info: call("info"), warn: call("warn"), error: call("error"), debug: call("debug") };
}
function safeStr(v) {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}




/** 给 wake 用的轻量 logger（失败不影响业务） */
function sdkLogger(ctx) {
  const lg = ctx && ctx.logger;
  const call = (lv) => (m) => {
    try {
      const fn = lg && lg[lv];
      if (typeof fn !== "function") return;
      const r = fn.call(lg, String(m));
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* ignore */ }
  };
  return { info: call("info"), warn: call("warn"), error: call("error"), debug: call("debug") };
}
