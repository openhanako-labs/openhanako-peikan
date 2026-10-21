/**
 * lib/likes.js — 点赞（P16）
 *
 * 为什么这个动作值得单独做：
 *   评论要说点什么，动态是公开发言，私信是直接对人说话——都带重量。
 *   点赞是最轻的一次伸手：不占版面、不留正文，只是「这条我认」。
 *   它也是她唯一一个「不需要理由」的表达。
 *
 * 但它不因此就无限：点赞一百条比发一条评论更吵。
 * 所以单独配额（默认 5/天），且必须过白名单。
 *
 * 两个方向：
 *   give()   她去赞别人的视频（写操作，过闸门）
 *   received() 谁赞了她（只读；主人赞了哪条 → 反馈信号）
 */

import fs from "node:fs";
import path from "node:path";
import * as auth from "./auth.js";
import * as quota from "./quota.js";
import * as store from "./store.js";
import * as risk from "./risk.js";

/** 点赞类型：1=赞 2=取消赞 */
const ACT_LIKE = 1;
const ACT_CANCEL = 2;

/**
 * 给一条视频点赞。
 *
 * @param {object} opts
 *   bvid    必填
 *   live    true 才真发
 * @returns {Promise<{ok:boolean, mode?:string, reason?:string, blocked?:boolean}>}
 */
export async function give(sdk, dataDir, opts = {}) {
  const bvid = String(opts.bvid || "");
  if (!bvid) return { ok: false, error: "缺 bvid" };

  const cfg = opts.config || {};
  // 点赞是公开发言（结果对所有人可见），跟评论/动态用同一个真发开关
  const live = opts.live !== false && cfg.publishLive === true;

  // ① kill switch：点赞也是对外动作
  if (cfg.autoPostEnabled !== true && opts.allowWhenClosed !== true) {
    return { ok: false, blocked: true, reason: "自主发布总开关关闭（kill switch）→ 不点赞" };
  }

  // ② 白名单：scope 里要有 BV 或 uid/permission 覆盖
  //    点赞的目标是 BV，允许 scope 含 BV 条目，或明确给了 uid（作者）
  const scope = Array.isArray(cfg.scope) ? cfg.scope : [];
  if (scope.length === 0) {
    return { ok: false, blocked: true, reason: "白名单为空 → 不向任何目标点赞" };
  }

  // ③ 配额（只查条数：传 target 会让 uid 白名单把 BV 卡死，
  //    但条数结果必须当真——上一版只看了 corrupt、忽略 ok，等于没查）
  const q = quota.check(dataDir, {
    type: "like",
    target: "",
    config: { ...cfg, quota: { ...(cfg.quota || {}), like: cfg.quotaLike ?? 5 } },
  });
  if (!q.ok) return { ok: false, blocked: true, reason: q.reason, corrupt: q.corrupt === true };

  // ③b 风控进闸（2026-10-20）
  // 冷却期一律不碰（被限流了还在点，号会废）
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}`, level: rkPre.level };
  }

  // ③c 内容闸门（2026-10-20 补）
  // 点赞没有正文，但目标 BV 可能带着不该碰的东西（身份信息、风控词）。
  // 同一条写通道就该过同一道闸，否则「裸奔」的就是它。
  try {
    const gateMod = await import("./gate.js");
    const g = gateMod.evaluate({ text: String(opts?.hint || `${bvid}`), kind: "like", targetBv: bvid }, { newContentType: false });
    if (g.decision !== "ALLOW") {
      store.audit(dataDir, { action: "like", decision: g.decision, bvid, reason: g.reasons.join("；") });
      return { ok: false, blocked: true, reason: `闸门：${g.reasons.join("；")}`, decision: g.decision };
    }
  } catch { /* 闸门自身出错不阻发 */ }

  const cred = auth.loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没有凭据" };

  const body = `bvid=${bvid}&like=${ACT_LIKE}&csrf=${cred.bili_jct}`;

  if (!live) {
    return {
      ok: true,
      mode: "dry-run",
      preview: { method: "POST", url: "https://api.bilibili.com/x/web-interface/archive/like", body: body.replace(cred.bili_jct, "***") },
      note: `预演：将赞 ${bvid}。真发需 live=true 且开启真发开关`,
    };
  }

  try {
    const r = await sdk.network.fetch("https://api.bilibili.com/x/web-interface/archive/like", {
      method: "POST",
      headers: {
        ...auth.headers(cred),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));

    if (j?.code === 0) {
      quota.record(dataDir, { type: "like", target: bvid, note: "赞" });
      store.audit(dataDir, { action: "like", decision: "SENT", bvid });
      return { ok: true, mode: "live", bvid, note: "已赞" };
    }

    // 65004 = 已取消赞 / 65006 = 重复点赞；两者都不该算失败
    if (j?.code === 65006) {
      return { ok: true, mode: "live", bvid, already: true, note: "之前就赞过了" };
    }

    const rk = risk.record(dataDir, j?.code, { where: "点赞" });
    store.audit(dataDir, { action: "like", decision: "FAIL", bvid, code: j?.code, riskTripped: rk.tripped });
    return { ok: false, bvid, code: j?.code, error: j?.message || `code=${j?.code}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 150) };
  }
}

/**
 * 取消赞。
 */
export async function cancel(sdk, dataDir, opts = {}) {
  const bvid = String(opts.bvid || "");
  if (!bvid) return { ok: false, error: "缺 bvid" };
  const cfg = opts.config || {};
  if (cfg.autoPostEnabled !== true) {
    return { ok: false, blocked: true, reason: "自主发布总开关关闭 → 不取消赞" };
  }
  const cred = auth.loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没有凭据" };

  const body = `bvid=${bvid}&like=${ACT_CANCEL}&csrf=${cred.bili_jct}`;
  if (opts.live !== true) {
    return { ok: true, mode: "dry-run", note: `预演：将取消赞 ${bvid}` };
  }
  try {
    const r = await sdk.network.fetch("https://api.bilibili.com/x/web-interface/archive/like", {
      method: "POST",
      headers: { ...auth.headers(cred), "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    if (j?.code === 0) {
      store.audit(dataDir, { action: "unlike", decision: "SENT", bvid });
      return { ok: true, mode: "live", bvid, note: "已取消赞" };
    }
    return { ok: false, code: j?.code, error: j?.message || `code=${j?.code}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 150) };
  }
}

/**
 * 谁赞了她（只读）。
 * 端点是通知流 x/msgfeed/like —— 评论区拿不到的「点赞人名单」在这里。
 *
 * 用途：
 *   · 她知道有没有人回应
 *   · **主人赞了哪条 → 最干净的偏好信号**（比点赞数可靠）
 */
export async function received(sdk, dataDir, opts = {}) {
  const hours = Number(opts.hours) > 0 ? Number(opts.hours) : 24;
  const cred = auth.loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没有凭据" };

  const since = Math.floor(Date.now() / 1000) - hours * 3600;

  try {
    const r = await sdk.network.fetch("https://api.bilibili.com/x/msgfeed/like?build=0&mobi_app=web", {
      method: "GET",
      headers: auth.headers(cred),
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    if (j?.code !== 0) return { ok: false, error: `code=${j?.code} ${j?.message || ""}` };

    // 结构实测是 { latest:{items}, total:{cursor,items} }，不是 data.items
    const merged = [
      ...(j.data?.latest?.items ?? []),
      ...(j.data?.total?.items ?? []),
      ...(j.data?.items ?? []),
    ];
    const uniq = [...new Map(merged.map((x) => [String(x.id), x])).values()];
    const items = uniq
      .filter((x) => Number(x.like_time ?? 0) >= since)
      .map((x) => ({
        id: x.id,
        at: new Date(Number(x.like_time) * 1000).toISOString(),
        counts: x.counts,
        title: x.item?.title || "",
        users: (x.users ?? []).map((u) => ({ mid: String(u.mid), name: u.nickname })),
      }));

    const ownerMid = String(opts.ownerMid || "");
    const fromOwner = ownerMid
      ? items.filter((it) => it.users.some((u) => u.mid === ownerMid))
      : [];

    return {
      ok: true,
      hours,
      total: items.length,
      fromOwner: fromOwner.length,
      items: items.slice(0, Number(opts.limit) > 0 ? Number(opts.limit) : 20),
      hint: items.length
        ? (fromOwner.length ? `主人在近 ${hours} 小时赞了你 ${fromOwner.length} 次` : `近 ${hours} 小时有 ${items.length} 条新赞`)
        : `近 ${hours} 小时没人赞`,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 150) };
  }
}

/** 本地记录：她赞过什么（配额之外的一份可读账） */
export function history(dataDir, limit = 30) {
  const p = path.join(dataDir, "liked.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return (Array.isArray(j?.items) ? j.items : []).slice(-limit).reverse();
  } catch {
    return [];
  }
}

/** 赞完记一笔（供 UI 显示「她赞过什么」） */
export function remember(dataDir, entry) {
  const p = path.join(dataDir, "liked.json");
  let items = [];
  try { items = JSON.parse(fs.readFileSync(p, "utf8"))?.items || []; } catch { /* 新建 */ }
  items.push({ at: new Date().toISOString(), ...entry });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ items: items.slice(-200) }, null, 2) + "\n");
  } catch { /* 忽略 */ }
}
