/**
 * lib/register-tasks.js — 定时任务（P3.1：真生物钟）
 *
 * 关键变化（照 dsh-bili-whale 语义）：
 *   ✗ 不用 intervalMs（那是等距 cron，一天八次，像秒表）
 *   ✓ 用 runAt 排**一次性**任务；每次醒来后重算下一趟
 *
 * handler：
 *   rhythm.wake   → 跑一轮浏览 + 记 woke + 排下一趟
 *   rhythm.plan   → 只算下一趟并排程（启动时 / 跨天时用）
 *   health.tick   → 登录态体检（这条用 intervalMs 是合适的，它就该是节拍）
 */

import fs from "node:fs";
import path from "node:path";
import { readConfig } from "./config.js";
import * as browse from "./browse.js";
import * as rhythm from "./rhythm.js";
import * as notify from "./notify.js";
import * as wake from "./wake.js";
import * as msgfeed from "./msgfeed.js";
import * as imbox from "./imbox.js";
import * as feedback from "./feedback.js";
import * as allowlist from "./allowlist.js";
import * as auth from "./auth.js";
import { verifySession } from "./auth.js";

const KEYS = {
  wake: "rhythm.wake",
  plan: "rhythm.plan",
  health: "health.tick",
  inbox: "inbox.tick",
  digest: "digest.daily",
};

export async function registerTasks(sdk, log) {
  const dataDir = sdk.dataDir || "";
  const logger = log || wrapLogger(sdk && sdk.logger);
  const offs = [];
  const cfgOf = async () => {
    try { return await readConfig(sdk); } catch { return {}; }
  };

  /** 把 plan 排成一次性任务 */
  async function scheduleNext(plan, cfg) {
    try {
      // 已有的一次性 rhythm 排程先清掉，避免叠层
      await clearRhythmSchedules(sdk, logger);
      const ts = rhythm.planToTimestamp(plan);
      const runAt = ts && ts > Date.now() ? ts : rhythm.tomorrowFirstWindowTs(cfg);
      await sdk.tasks.schedule({
        handlerKey: KEYS.wake,
        runAt,
        label: `奥菲莉娅 · 醒（${new Date(runAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}）`,
        enabled: true,
      });
      logger.info(`下一趟已排：${new Date(runAt).toLocaleString("zh-CN")}（${plan.action === "skip" ? "不看那趟" : `窗口 ${plan.window}`}）`);
      return runAt;
    } catch (e) {
      logger.warn(`排程失败：${e.message}`);
      return null;
    }
  }

  // ── handler：醒来 ──────────────────────────────────────────────────
  try {
    const off = await sdk.tasks.registerHandler(KEYS.wake, {
      run: async () => {
        const cfg = await cfgOf();

        // 先看计划是「醒」还是「等」：wait 到点只重算，不跑浏览
        const before = rhythm.status(dataDir).plan;
        if (before && before.action === "wait") {
          const plan = rhythm.planAndSave(dataDir, cfg);
          await scheduleNext(plan, cfg);
          logger.info(`[rhythm.wake] 窗口已到，重算计划 → ${plan.action}`);
          return { ok: true, action: "replan", plan };
        }

        // 1. 跑一轮（按 wakeMode 分派：rule / brain，brain 失败时自动兜底）
        //
        // 2026-10-21 修：之前这里只传了 8 个字段，ownerMid / shareToOwner /
        // shareMaxPerDay 全漏 → 每次定时醒来分享都报「未配置 ownerMid」，
        // 而 config.json 里明明配了。用一个对象展开展开，避免再漏。
        const r = await wake.wakeOnce(sdk, dataDir, {
          ...cfg,
          round: "content",   // 到点自己看一轮：只看、只递
          wakeMode: cfg.wakeMode,
          brainFallback: cfg.brainFallback,
          maxVideos: cfg.maxVideos,
          deepRead: cfg.deepRead,
          like: cfg.like,
          dislike: cfg.dislike,
          minScore: cfg.minScore,
          ownerMid: cfg.ownerMid,
          shareToOwner: cfg.shareToOwner,
        }, logger);
        // 2. 记 woke 并重算下一趟
        const plan = rhythm.markWoke(dataDir, cfg);
        // 3. 排下一趟
        await scheduleNext(plan, cfg);
        // 4. 通知（只推值得的，不推流水账）
        let nres = { pushed: false, reason: "跳过" };
        if (cfg.notifyOnWake !== false) {
          try {
            nres = await notify.afterWake(sdk, dataDir, {
              ok: r.ok, skipped: r.skipped, error: r.error, note: r.note, best: r.best,
            });
          } catch (e) {
            nres = { pushed: false, reason: `通知异常：${e.message}` };
          }
        }

        // 4.5 分享已内包在 wakeOnce 里（手动与定时走同一条路，不重复）
        const sres = r.share || { sent: false, reason: "跳过" };
        logger.info(`[rhythm.wake] ${r.skipped ? "没看" : `模式 ${r.mode}、写了 ${r.wrote} 条`} → 下一趟 ${plan.action}｜通知：${nres.reason}｜分享：${sres.reason}`);
        return { ok: r.ok, mode: r.mode, wrote: r.wrote, browse: { screened: r.rule?.screened, deepRead: r.wrote }, next: plan, notify: nres, share: sres, brainError: r.brainError };
      },
    });
    if (typeof off === "function") offs.push(off);
  } catch (e) {
    logger.warn(`handler 注册失败 ${KEYS.wake}：${e.message}`);
  }

  // ── handler：只算计划 ─────────────────────────────────────────────
  try {
    const off = await sdk.tasks.registerHandler(KEYS.plan, {
      run: async () => {
        const cfg = await cfgOf();
        const plan = rhythm.planAndSave(dataDir, cfg);
        await scheduleNext(plan, cfg);
        return plan;
      },
    });
    if (typeof off === "function") offs.push(off);
  } catch (e) {
    logger.warn(`handler 注册失败 ${KEYS.plan}：${e.message}`);
  }

  // ── handler：立即重算并重排（维护用，工具可调）──────────────────────
  try {
    await sdk.tasks.registerHandler("rhythm.replan", {
      run: async () => {
        const cfg = await cfgOf();
        const plan = rhythm.planAndSave(dataDir, cfg);
        const at = await scheduleNext(plan, cfg);
        logger.info(`[rhythm.replan] 已重排到 ${at ? new Date(at).toLocaleString("zh-CN") : "明天"}`);
        return { ok: true, plan, at };
      },
    });
  } catch (e) {
    logger.warn(`handler 注册失败 rhythm.replan：${e.message}`);
  }

  // ── handler：轮询收件箱（C 档的关键：她得知道自己有没有人找）
  //
  // 为什么单独一条任务而不搭在醒来上：
  //   醒来一天最多 3 次，但一条回复可能中间隔两小时就来了。
  //   搭在醒来上的话，人家上午回你、你晚上才知道。
  //
  // 间隔：10 分钟。这个频率不高（一天 144 次轻请求），但足够让她“在场”。
  try {
    const off = await sdk.tasks.registerHandler(KEYS.inbox, {
      run: async () => {
        const cfg = await cfgOf();
        // 注意：kill switch 不该影响「听」。
        //
        // 改（2026-10-20）：之前 kill switch 关着就整条 return，
        // 连收件箱都不拉——那结果是「她人不在场」，而不是「她只读」。
        // 听是只读动作，不该被发言开关拦住；只有「回不回」才归 kill switch 管。
        // （回复那层在 reply.canReply() 里自己会拦，不依赖这里。）
        const cred = auth.loadCredentials(dataDir);
        if (!cred) return { ok: false, error: "没有凭据" };

        const st = msgfeed.status(dataDir);
        const since = Math.max(Number(st.replySeenAt || 0), Number(st.atSeenAt || 0));
        const r = await msgfeed.poll(sdk, dataDir, { baseHeaders: auth.headers(cred), pages: 1 });
        if (!r.ok && !r.items?.length) {
          return { ok: false, error: (r.errors || []).join("；") };
        }

        const fresh = (r.items || []).filter((x) => Number(x.t) > since);

        // 记住找过她的人（供 reply-to-me 白名单）
        if ((r.items || []).length) {
          allowlist.rememberPeople(dataDir, r.items.map((x) => ({ mid: x.mid, name: x.who })));
        }

        // 推水位
        msgfeed.advanceWater(dataDir, r.items || []);

        // ── 私信也一起听 ──
        // 之前只听评论回复和 @，私信那条路只能发不能收 → 她听不见你私信她。
        // 2026-10-21：onlyNew=true —— 只报没见过的，避免同一条私信每 10 分钟叫醒一次。
        let dmFresh = [];
        try {
          const u = await imbox.unreplied(sdk, dataDir, { cred, onlyNew: true });
          dmFresh = (u.items || []).map((x) => ({
            id: x.id, who: x.name || `uid ${x.mid}`, mid: x.mid,
            body: x.text, kind: "dm", context: x.context,
          }));
          // 推进水位：这一批算「看过了」，下轮不再报
          if (dmFresh.length) {
            try { imbox.markSeen(dataDir, dmFresh.map((x) => x.id)); } catch { /* 忽略 */ }
          }
        } catch { /* 私信读失败不影响评论监听 */ }

        if (!fresh.length && !dmFresh.length) return { ok: true, fresh: 0 };

        // 从主人的话里读反馈（语义判断，非关键词）
        //
        // 为什么放在这里：主人对她说的话，往往就是「这类我不想看」这种反馈。
        // 不接住就白说了——她的口味永远不会变。
        if (dmFresh.length) {
          const cands = (() => { try { return feedback.candidatesFrom(dataDir, cfg); } catch { return []; } })();
          for (const d of dmFresh.slice(0, 3)) {
            try {
              await feedback.digest(sdk, dataDir, {
                text: d.body,
                context: (d.context || []).map((x) => x.text).join(" / "),
                who: "owner",
                candidates: cands,
              });
            } catch { /* 反馈理解失败不影响主流程 */ }
          }
        }
        if (fresh.length) {
          for (const f0 of fresh.slice(0, 3)) {
            try {
              await feedback.digest(sdk, dataDir, {
                text: msgfeed.bodyOf(f0),
                who: "owner",
              });
            } catch { /* 忽略 */ }
          }
        }

        // 有消息，但能不能回由 kill switch 决定
        if (cfg.autoPostEnabled !== true) {
          const n = fresh.length + dmFresh.length;
          logger.info(`[inbox.tick] ${n} 条新消息（只读模式，只记录不回）`);
          return { ok: true, fresh: n, skipped: "kill switch 关闭 → 听到了，但不回" };
        }

        logger.info(`[inbox.tick] ${fresh.length + dmFresh.length} 条新消息（评论 ${fresh.length} · 私信 ${dmFresh.length}）→ 叫醒她`);

        // 有新消息 → 叫醒她，让她自己决定回不回
        const r2 = await wake.wakeOnce(sdk, dataDir, {
          ...cfg,
          round: "social",              // 有人找她：这一轮只回话
          wakeMode: "brain",            // 回话要模型判断，强制 brain
          // 2026-10-22：收件箱刚拉过，把结果传给它复用，别让它再拉一遍。
          pendingCount: fresh.length + dmFresh.length,
          inboxHint: [
            ...fresh.slice(0, 5).map((x) => ({
              id: x.id, who: x.who, mid: x.mid, body: msgfeed.bodyOf(x), kind: x.kind,
            })),
            ...dmFresh.slice(0, 3),
          ],
        }, logger);

        return { ok: true, fresh: fresh.length + dmFresh.length, comments: fresh.length, dms: dmFresh.length, woke: r2.wrote || 0, share: r2.share || null };
      },
    });
    if (typeof off === "function") offs.push(off);

    // 收件箱轮询间隔
    //
    // 关于「廉价」（参考 dsh-bili-whale 的 comment-await）：
    //   它的做法是「廉价进程每 5 分钟看一眼，没人回就用任务结束叫醒 agent」
    //   → 没人回 = 0 token。
    //
    //   我们这里本来就是 0 token：
    //     无新消息 → `if (!fresh.length && !dmFresh.length) return` 直接返回，
    //     全程不碰模型。跟它的便宜程度一样，只是实现路径不同（它是外部进程，我们是宿主任务）。
    //
    //   所以这里真正要补的只是「间隔可调」和「不重复排」。
    // 2026-10-20 修：之前直接 schedule，每次重载都多一条，
    // 结果同一个 handler 跑 N 遍（digest 就是这样在 22:00 跑了四次）。
    const cfg0 = await cfgOf();
    const mins = Math.max(2, Number(cfg0.inboxIntervalMinutes) || 10);
    await clearHandlerSchedules(sdk, logger, KEYS.inbox);
    await sdk.tasks.schedule({
      handlerKey: KEYS.inbox,
      intervalMs: mins * 60 * 1000,
      enabled: true,
    });
    logger.info(`[inbox.tick] 收件箱监听已启动（每 ${mins} 分钟，无消息时 0 token，旧排程已清）`);
  } catch (e) {
    logger.warn(`handler 注册失败 ${KEYS.inbox}：${e.message}`);
  }

  // ── handler：手动叫醒（后台）────────────────────────────────────
  // 为什么要这个：宿主给 App 工具回调的窗口是 30 秒（实测报错
  // App invocation expired or belongs to another App）。
  // brain 模式要跑 4~6 轮模型，必然超时。
  // 所以工具只负责写一个请求 + 排 3 秒后的一次性任务，
  // 真正干活在这里（用 App 长生命周期的 sdk，不是工具闭包里的 ctx）。
  try {
    const off = await sdk.tasks.registerHandler("wake.manual", {
      run: async () => {
        const reqPath = path.join(dataDir, "wake-request.json");
        let req = null;
        try {
          req = JSON.parse(fs.readFileSync(reqPath, "utf8"));
        } catch {
          return { ok: false, reason: "没有叫醒请求，跳过" };
        }
        // 用过就删，避免重复跑
        try { fs.unlinkSync(reqPath); } catch { /* 忽略 */ }

        const cfg = await cfgOf();
        try {
          const r0 = await wake.wakeOnce(sdk, dataDir, {
            round: "content",   // 手动叫醒默认按「自己看一轮」
            wakeMode: req.mode === "brain" ? "brain" : (req.mode === "rule" ? "rule" : cfg.wakeMode),
            brainFallback: cfg.brainFallback,
            skipChance: req.force ? 0 : cfg.skipChance,
            maxVideos: cfg.maxVideos,
            deepRead: cfg.deepRead,
            like: cfg.like,
            dislike: cfg.dislike,
            minScore: cfg.minScore,
            shareToOwner: cfg.shareToOwner,
            ownerMid: cfg.ownerMid,
          }, logger);

          let plan0 = null;
          try { plan0 = rhythm.markWoke(dataDir, cfg); } catch { /* 忽略 */ }

          // 重算并排下一趟，否则手动醒一次会打乱生物钟
          try { await scheduleNext(rhythm.planAndSave(dataDir, cfg), cfg); } catch { /* 忽略 */ }

          logger.info(
            `[wake.bg] 跑完了：模式 ${r0.mode}、写了 ${r0.wrote} 条` +
            (r0.noteWhy ? `｜没写原因：${r0.noteWhy}` : "") +
            (r0.brainError ? `｜brain 失败：${r0.brainError}` : "") +
            (r0.share && r0.share.sent ? "｜分享：已发" : `｜分享：${r0.share ? r0.share.reason : "跳"}`)
          );
          return { ok: r0.ok, mode: r0.mode, wrote: r0.wrote, plan: plan0 };
        } catch (e) {
          logger.warn(`[wake.bg] 失败：${e && e.message ? e.message : e}`);
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      },
    });
    if (typeof off === "function") offs.push(off);
  } catch (e) {
    logger.warn(`handler 注册失败 wake.manual：${e.message}`);
  }

  // ── handler：健康心跳（这条用 interval 是合理的）────────────────────
  try {
    const off = await sdk.tasks.registerHandler(KEYS.health, {
      run: async () => {
        const s = await verifySession(sdk, dataDir);
        if (!s.ok) logger.warn(`[health.tick] 登录态异常：${s.detail}`);
        return s;
      },
    });
    if (typeof off === "function") offs.push(off);
  } catch (e) {
    logger.warn(`handler 注册失败 ${KEYS.health}：${e.message}`);
  }

  // ── handler：每日一次「谁找过她」摘要 ──────────────────────
  //
  // 以前 comment_digest 只能手动拉。人不会天天记得去拉，
  // 那就等于没这个功能。现在每天推一次，就一句话 + 几条。
  try {
    const off = await sdk.tasks.registerHandler(KEYS.digest, {
      run: async () => {
        const cfg = await cfgOf();
        if (cfg.digestToOwner === false) return { ok: true, skipped: "开关关着" };

        const cred = auth.loadCredentials(dataDir);
        if (!cred) return { ok: false, reason: "没有凭据" };

        try {
          const headers = auth.headers(cred);
          const got = await msgfeed.poll(sdk, dataDir, { baseHeaders: headers, pages: 2 });
          const since = Math.floor(Date.now() / 1000) - 24 * 3600;
          const items = (got.items || []).filter((x) => Number(x.t) >= since);

          let dms = [];
          try {
            const u = await imbox.unreplied(sdk, dataDir, { cred });
            dms = (u.items || []).slice(0, 5);
          } catch { /* 忽略 */ }

          const total = items.length + dms.length;
          if (!total) {
            logger.info("[digest.daily] 今天没人找她，不推");
            return { ok: true, total: 0 };
          }

          // 拼一句话 + 前几条
          const lines = [];
          lines.push(`今天有 ${total} 条在跟她说话。`);
          for (const x of items.slice(-5)) {
            lines.push(`· ${x.who}（${x.kind === "at" ? "@她" : "回她"}）：${msgfeed.bodyOf(x).slice(0, 60)}`);
          }
          for (const d of dms.slice(0, 3)) {
            lines.push(`· ${d.name || d.mid}（私信）：${String(d.text || "").slice(0, 60)}`);
          }

          const r = await notify.push(sdk, dataDir, {
            title: "陪看 · 今天谁找过她",
            body: lines.join("\n"),
          });
          logger.info(`[digest.daily] 推了 ${total} 条（${r.ok ? "成功" : r.skipped || "失败"}）`);
          return { ok: r.ok, total };
        } catch (e) {
          logger.warn(`[digest.daily] 失败：${e && e.message ? e.message : e}`);
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      },
    });
    if (typeof off === "function") offs.push(off);

    // 每晚 22:00 一次
    //
    // 2026-10-20 两次修：
    //   ① 一开始没去重 → 每次重载都排一条，今天重载四次 = 排了四条，22:00 跑了四遍。
    //   ② 只加「有就不排」不够 —— 已经排进去的旧条目不会被清。
    //      现在：先清干净这个 handlerKey 的所有旧排程，再排一条新的。
    await clearHandlerSchedules(sdk, logger, KEYS.digest);

    const now = new Date();
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    await sdk.tasks.schedule({
      handlerKey: KEYS.digest,
      runAt: at.getTime(),
      label: "陪看 · 每日互动摘要",
      enabled: true,
    });
    logger.info(`[digest.daily] 已排：${at.toLocaleString("zh-CN")}（旧的已清）`);
  } catch (e) {
    logger.warn(`handler 注册失败 ${KEYS.digest}：${e.message}`);
  }

  // ── 启动排程 ─────────────────────────────────────────────────────
  const cfg = await cfgOf();

  // 清掉旧的 intervalMs 版 browse.tick（P3 遗留）
  await clearHandlerSchedules(sdk, logger, "browse.tick");

  // 算今天这一趟并排程
  const existing = await safeList(sdk, logger);
  const hasRhythm = existing.some((s) => s.handlerKey === KEYS.wake && s.enabled !== false);
  if (!hasRhythm) {
    const plan = rhythm.planAndSave(dataDir, cfg);
    await scheduleNext(plan, cfg);
    logger.info(`生物钟已启动：今天最多醒 ${cfg.maxWakesPerDay ?? 3} 次，窗口 ${cfg.nightWindows || "(默认)"}`);
  } else {
    logger.info("生物钟排程已存在，不重复创建");
  }

  // 健康心跳（intervalMs 合理）
  // 2026-10-20 修：hasHealth 只防新增，不防已经存在的重复。
  // 改成先清后建，只留一条。
  await clearHandlerSchedules(sdk, logger, KEYS.health);
  try {
    await sdk.tasks.schedule({
      handlerKey: KEYS.health,
      intervalMs: 30 * 60 * 1000,
      label: "奥菲莉娅 · 健康心跳",
      enabled: true,
    });
  } catch (e) { logger.warn(`health 排程失败：${e.message}`); }

  return () => {
    for (const off of offs) { try { off(); } catch { /* teardown */ } }
  };
}

async function safeList(sdk, logger) {
  try {
    const fn = sdk.tasks && sdk.tasks.listSchedules;
    if (typeof fn !== "function") return [];
    const r = await fn.call(sdk.tasks);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    logger.warn(`listSchedules 失败：${e.message}`);
    return [];
  }
}

/** 清掉本 App 的一次性 rhythm 排程 */
async function clearRhythmSchedules(sdk, logger) {
  const list = await safeList(sdk, logger);
  for (const s of list) {
    if (s.handlerKey !== KEYS.wake) continue;
    try { await sdk.tasks.unschedule(s.scheduleId); } catch { /* 忽略 */ }
  }
}

/** 清掉某个 handlerKey 的全部排程 */
async function clearHandlerSchedules(sdk, logger, key) {
  const list = await safeList(sdk, logger);
  for (const s of list) {
    if (s.handlerKey !== key) continue;
    try { await sdk.tasks.unschedule(s.scheduleId); } catch { /* 忽略 */ }
  }
}

/** v2 logger 返回 Promise 且只打 format；包一层 v1 风格。 */
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
