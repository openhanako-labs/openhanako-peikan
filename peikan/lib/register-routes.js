/**
 * lib/register-routes.js — 卡片后端路由（P0）
 *
 * 挂载前缀由宿主决定（/api/apps/<appId>/routes）。
 * 只读接口为主：工作台各 tab 取数。写入类只允许「人审拍板」与「凭据写入」。
 *
 * ⚠️ 设计约束（2026-10-19 实证）：
 *   宿主给【功能面板】这类轻量挂载位的 iframe 不保证带 appSurfaceSession，
 *   而 routes 必须靠它鉴权（官方：iframe 装载票据只负责 ui/ 文档，不能当路由凭证；
 *   SDK 源码亦硬抛 "hana.api.fetch requires appSurfaceSession in the iframe URL"）。
 *   → 功能面板不做 HTTP 取数，改为诚实的静态展示；取数由主卡（整页卡）负责。
 */

import { readConfig } from "./config.js";
import { hasCredentials, saveCredentials, verifySession, loadCredentials, headers as authHeaders } from "./auth.js";
import * as quota from "./quota.js";
import * as store from "./store.js";
import * as rhythm from "./rhythm.js";
import * as identity from "./identity.js";
import * as settings from "./settings.js";
import * as msgfeed from "./msgfeed.js";
import * as imbox from "./imbox.js";
import * as allowlist from "./allowlist.js";
import * as taste from "./taste.js";
import * as silence from "./silence.js";
import * as likes from "./likes.js";
import * as retract from "./retract.js";
import fs from "node:fs";
import path from "node:path";

export async function registerRoutes(ctx, log) {
  const _log = log || wrapLogger(ctx && ctx.logger);
  const dataDir = ctx.dataDir || "";
  const off = await ctx.routes.register((app) => {
    app.get("/health", async (c) => {
      const cfg = await readConfig(ctx);
      return c.json({
        ok: true,
        stage: "P6",
        credentialsConfigured: hasCredentials(dataDir),
        session: await verifySession(ctx, dataDir),
        quota: quota.status(dataDir, cfg),
        autoPostEnabled: cfg.autoPostEnabled === true,
        publishLive: cfg.publishLive === true,
        notes: store.listNotes(dataDir, 500).length,
        review: store.listReview(dataDir, "pending").length,
      });
    });

    // 作息状态（卡片用）
    app.get("/rhythm", async (c) => {
      const cfg = await readConfig(ctx);
      return c.json({
        ...rhythm.status(dataDir),
        maxWakesPerDay: cfg.maxWakesPerDay,
        skipChance: cfg.skipChance,
        windows: rhythm.parseWindows(cfg.nightWindows),
      });
    });

    app.get("/diary", async (c) => {
    const which = c.req.query("which") === "executive" ? "executive" : "private";
    return c.json({ ok: true, which, items: store.readDiary(dataDir, which, 60) });
  });

  app.get("/notes", async (c) => {
      const limit = Number(c.req.query("limit")) > 0 ? Number(c.req.query("limit")) : 100;
      return c.json({ ok: true, items: store.listNotes(dataDir, limit) });
    });

    app.get("/drafts", async (c) => c.json({ ok: true, items: store.listDrafts(dataDir) }));

    app.get("/review", async (c) => {
      const status = c.req.query("status") || "";
      return c.json({ ok: true, items: store.listReview(dataDir, status || undefined) });
    });

    app.post("/review/:id", async (c) => {
      const id = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      const status = body?.status === "rejected" ? "rejected" : "resolved";
      const it = store.resolveReview(dataDir, id, status);
      return c.json({ ok: Boolean(it), item: it });
    });

    app.get("/quota", async (c) => { const cfg = await readConfig(ctx); return c.json({ ok: true, ...quota.status(dataDir, cfg) }); });

    app.get("/audit", async (c) => {
      const limit = Number(c.req.query("limit")) > 0 ? Number(c.req.query("limit")) : 200;
      return c.json({ ok: true, items: store.listAudit(dataDir, limit) });
    });

    // ── 互动页：谁找过她 / 白名单 ────────────────────────────
    app.get("/digest", async (c) => {
      const hours = Number(c.req.query("hours")) > 0 ? Number(c.req.query("hours")) : 24;
      const cred = loadCredentials(dataDir);
      if (!cred) return c.json({ ok: false, error: "未配置凭据", items: [] });
      try {
        const headers = authHeaders(cred);
        const now = Math.floor(Date.now() / 1000);
        const since = now - hours * 3600;

        const got = await msgfeed.poll(ctx, dataDir, { baseHeaders: headers, pages: 2 });
        let dms = [];
        try {
          const u = await imbox.unreplied(ctx, dataDir, { cred });
          dms = (u.items || []).map((x) => ({
            kind: "dm", who: x.name || `uid ${x.mid}`, mid: String(x.mid), body: x.text, t: 0,
          }));
        } catch { /* 私信读失败不影响评论 */ }

        const items = [
          ...(got.items || []).map((x) => ({
            kind: x.kind === "at" ? "@我" : "回复",
            who: x.who, mid: x.mid, at: Number(x.t) || 0, body: msgfeed.bodyOf(x),
          })),
          ...dms,
        ].filter((x) => !x.at || x.at >= since).slice(-40);

        return c.json({ ok: true, hours, total: items.length, items });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e), items: [] });
      }
    });

    app.get("/allowlist", async (c) => {
      try {
        const cfg = await readConfig(ctx);
        return c.json({ ok: true, ...allowlist.describe(cfg.scope, dataDir) });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    app.post("/allowlist/forget", async (c) => {
      try {
        return c.json({ ok: true, ...allowlist.forgetPeople(dataDir) });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    // ── 学到页：口味 / 沉默 / 点赞 ────────────────────────────
    app.get("/taste", async (c) => {
      try {
        return c.json({ ok: true, ...taste.snapshot(dataDir, { limit: 30 }) });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    app.get("/silence", async (c) => {
      try {
        const cfg = await readConfig(ctx);
        return c.json({ ok: true, ...silence.silenceState(dataDir, cfg) });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    app.get("/likes", async (c) => {
      try {
        return c.json({ ok: true, ...({ items: likes.history(dataDir, 30) }) });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    // 她看过什么：从笔记里统计，不加新采集
    app.get("/watch", async (c) => {
      try {
        const notes = store.listNotes(dataDir, 500);
        const withDur = notes.filter((n) => Number(n.duration) > 0);
        const totalSec = withDur.reduce((s, n) => s + Number(n.duration), 0);

        // UP 主分布
        const ups = {};
        for (const n of notes) {
          const u = String(n.up || "").trim();
          if (u) ups[u] = (ups[u] || 0) + 1;
        }
        const topUps = Object.entries(ups)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([name, count]) => ({ name, count }));

        // 最近 7 天的量
        const weekAgo = Date.now() - 7 * 86400000;
        const recent = notes.filter((n) => {
          try { return new Date(n.at).getTime() >= weekAgo; } catch { return false; }
        });

        return c.json({
          ok: true,
          total: notes.length,
          weekCount: recent.length,
          totalHours: Math.round(totalSec / 3600),
          avgMinutes: withDur.length ? Math.round(totalSec / withDur.length / 60) : 0,
          topUps,
        });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    // ── 她发出去的东西 / 撤回 ────────────────────────────────
    app.get("/sent", async (c) => {
      try {
        return c.json({ ok: true, ...retract.sentList(dataDir) });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    app.post("/retract", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const cfg = await readConfig(ctx);
        const live = body.live === true && cfg.publishLive === true;
        // retract 没有统一入口，按 kind 分派
        const r = body.kind === "dynamic"
          ? await retract.dynamic(ctx, dataDir, { dynId: body.dynId, live, config: cfg })
          : await retract.comment(ctx, dataDir, { rpid: body.rpid, bvid: body.bvid, live, config: cfg });
        if (body.live === true && cfg.publishLive !== true) {
          return c.json({ ...r, note: "（已预演）全局 publishLive 关着，真删需先在设置里开" });
        }
        return c.json(r);
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    app.get("/config", async (c) => c.json({ ok: true, config: await readConfig(ctx) }));

    // ── 助手身份（P7）──────────────────────────────────────
    app.get("/identity", async (c) => {
      const sel = identity.readSelection(dataDir);
      const hasAvatar = Boolean(identity.avatarPath(dataDir));
      return c.json({
        ok: true,
        selection: sel,
        hasAvatar,
        personaLength: identity.readPersona(dataDir).length,
      });
    });

    app.get("/agents", async (c) => {
      const r = await identity.listAgents(ctx);
      return c.json(r);
    });

    app.post("/identity", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const patch = {};
      if (typeof body.agentId === "string") patch.agentId = body.agentId;
      if (typeof body.agentName === "string") patch.agentName = body.agentName;
      if (typeof body.model === "object" && body.model) patch.model = body.model;

      const sel = identity.writeSelection(dataDir, patch);

      // 切换助手只改「用哪个模型」，人格不动。
      //
      // 只有一个 persona.md，所有助手共用 —— 这是刻意的设计。
      // 原因：按助手分开存试过，但切换时的回退逻辑反复串人格，
      // 用户实测「切了没变」。与其修一个没必要复杂的机制，回到一个文件。
      const persona = identity.readPersona(dataDir);

      return c.json({
        ok: true,
        selection: sel,
        personaSwitched: false,
        personaLength: persona.length,
        note: "人格只有一份，切换助手不会改变它",
      });
    });

    app.get("/persona", async (c) => {
      // 跟实际 systemPrompt 用同一个来源，界面才看得到真相
      const sel = identity.readSelection(dataDir);
      const agentId = c.req.query("agentId") || sel.agentId || "";
      const r = await identity.resolvePersona(ctx, dataDir, agentId);
      return c.json({
        ok: true,
        agentId,
        persona: r.persona,
        length: r.length,
        source: r.source,          // override / agent-files / local / default
        files: r.files || null,    // agent-files 时给出每份文件的大小
      });
    });

    // 保存 = 写「覆盖版」（不动助手原始文件）
    app.post("/persona", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.persona !== "string") return c.json({ ok: false, error: "缺 persona 字符串" });
      const sel = identity.readSelection(dataDir);
      const agentId = String(body.agentId || sel.agentId || "");
      if (!agentId) return c.json({ ok: false, error: "还没有选中助手，无法保存覆盖版" });
      const r = identity.writeOverride(dataDir, agentId, body.persona);
      return c.json({ ...r, agentId, note: "已保存为覆盖版，不会改动助手原始文件" });
    });

    // 恢复助手原始设定（删覆盖版）
    app.post("/persona/reset", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const sel = identity.readSelection(dataDir);
      const agentId = String(body.agentId || sel.agentId || "");
      if (!agentId) return c.json({ ok: false, error: "没有选中助手" });
      const r = identity.clearOverride(dataDir, agentId);
      return c.json({ ...r, agentId });
    });

    // 头像：接收 base64（前端读文件后传）
    app.post("/avatar", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const b64 = String(body.data || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return c.json({ ok: false, error: "缺 data" });
      const ext = String(body.ext || "png").replace(/[^a-z]/gi, "").slice(0, 4) || "png";
      try {
        identity.saveAvatar(dataDir, Buffer.from(b64, "base64"), ext);
        return c.json({ ok: true });
      } catch (e) {
        return c.json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    // 图片回读：封面 / 抽帧图 / 字幕条
  // 卡片 <img src="..."> 直接用；路径白名单，不允许任意文件读取
  app.get("/frame", async (c) => {
    const kind = String(c.req.query("kind") || "cover");
    const bvid = String(c.req.query("bvid") || "").replace(/[^A-Za-z0-9]/g, "");
    if (!bvid) return c.body(null, 400);

    const map = {
      cover: path.join(dataDir, "covers", `${bvid}.jpg`),
      strip: path.join(dataDir, "covers", `${bvid}-substrip.jpg`),
      // 抽帧图的名字带格子尺寸，扫目录找该 BV 的最近一张
      sheet: (() => {
        const dir = path.join(dataDir, "frames");
        try {
          const hit = fs.readdirSync(dir)
            .filter((f) => f.startsWith(bvid + "-") && f.endsWith(".jpg"))
            .sort()
            .pop();
          return hit ? path.join(dir, hit) : "";
        } catch { return ""; }
      })(),
    };
    const p = map[kind];
    if (!p) return c.body(null, 400);

    // 围栏：只能在 dataDir 里
    const root = path.resolve(dataDir);
    if (!path.resolve(p).startsWith(root + path.sep)) return c.body(null, 403);

    try {
      if (!fs.existsSync(p)) return c.body(null, 404);
      return c.body(fs.readFileSync(p), 200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    } catch {
      return c.body(null, 500);
    }
  });

  // 助手头像：从 agents/<id>/avatars/ 读
  app.get("/agent-avatar", async (c) => {
    const id = String(c.req.query("id") || "");
    const p = identity.agentAvatarPath(id);
    if (!p) return c.body(null, 404);
    try {
      const ext = path.extname(p).toLowerCase();
      const mime = ext === ".webp" ? "image/webp" : (ext === ".jpg" || ext === ".jpeg") ? "image/jpeg" : "image/png";
      return c.body(fs.readFileSync(p), 200, { "content-type": mime, "cache-control": "no-store" });
    } catch {
      return c.body(null, 500);
    }
  });

  // 头像回读：直接返回图片字节（卡片 <img src="/avatar"> 用）
    app.get("/avatar", async (c) => {
      const p = identity.avatarPath(dataDir);
      if (!p) return c.body(null, 404);
      try {
        const buf = fs.readFileSync(p);
        const ext = path.extname(p).toLowerCase();
        const mime = ext === ".svg" ? "image/svg+xml"
          : ext === ".webp" ? "image/webp"
          : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
          : "image/png";
        return c.body(buf, 200, { "content-type": mime, "cache-control": "no-store" });
      } catch {
        return c.body(null, 500);
      }
    });

    // 写入配置：落到 ctx.config（该应用自己声明的 settings 作用域）
    app.post("/config", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const patch = body && typeof body === "object" ? body : {};
      // P17：配置自持——写 dataDir/config.json，不再走宿主的 ctx.config
      const r = await settings.apply(ctx, patch);
      return c.json({ ok: r.ok, applied: r.applied, rejected: r.rejected, warnings: r.warnings, error: r.error });
    });

    // 凭据写入：不回显，只回 ok/missing
    app.post("/credentials", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const r = saveCredentials(dataDir, body || {});
      return c.json(r.ok ? { ok: true } : { ok: false, missing: r.missing });
    });
  });
  _log.info("peikan 卡片路由已挂载（面板不取 HTTP，主卡负责取数）");
  return off;
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



