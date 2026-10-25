/**
 * lib/retract.js — 收回（P22）
 *
 * 为什么必须有：她能说话，但之前不能收回。
 * 一个只能前进不能后退的东西，不叫自主，叫失控。
 *
 * 能收的两种：
 *   · comment  删自己发的评论      POST x/v2/reply/del
 *   · dynamic  删自己发的动态      POST x/dynamic/feed/operate/remove
 *
 * 铁律：**只能删自己的**。接口层面 B站 也只允许删自己的，
 * 但这里再做一次本地校验——用 audit 里记过的 rpid/dynId 比对，
 * 防止「删了别人的」这种不可挽回的错。
 */

import fs from "node:fs";
import path from "node:path";
import * as auth from "./auth.js";
import * as store from "./store.js";
import * as risk from "./risk.js";

/** 从审计里找出「她真的发过」的条目 */
function findSent(dataDir, { rpid, dynId } = {}) {
  const p = path.join(dataDir, "audit.jsonl");
  let lines = [];
  try { lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean); }
  catch { return null; }

  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (String(j.decision) !== "SENT") continue;
    if (rpid && String(j.rpid) === String(rpid)) return j;
    if (dynId && String(j.dynId) === String(dynId)) return j;
  }
  return null;
}

/**
 * 删一条自己发的评论。
 *
 * @param {object} opts
 *   rpid   评论 id（必填）
 *   bvid   用于 referer（可选，但建议给）
 *   oid    稿件 aid；不给就现场查
 *   live   true 才真删
 */
export async function comment(sdk, dataDir, { rpid, bvid = "", oid = "", live = false, config = {} } = {}) {
  const id = String(rpid || "");
  if (!id) return { ok: false, error: "缺 rpid" };

  // ⓪ 风控进闸（删除也算写操作）
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}` };
  }

  // ⓪ kill switch：删除也是对外动作
  if (config.autoPostEnabled !== true) {
    return { ok: false, blocked: true, reason: "kill switch 关闭 → 只读，不删任何东西" };
  }

  // ① 本地校验：这条必须是她自己发过的
  const sent = findSent(dataDir, { rpid: id });
  if (!sent) {
    return {
      ok: false,
      blocked: true,
      reason: "审计里没有这条评论的发送记录 —— 不是她发的，不删",
    };
  }

  const cred = auth.loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没有凭据" };

  // ② 需要 aid
  let aid = String(oid || sent.oid || "");
  if (!aid) {
    const bv = bvid || sent.bvid || "";
    if (!bv) return { ok: false, error: "缺 oid，也没有 bvid 可查" };
    try {
      const vr = await sdk.network.fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, {
        method: "GET", headers: auth.headers(cred),
      });
      const vj = typeof vr.json === "function" ? await vr.json() : JSON.parse(String(vr));
      aid = String(vj?.data?.aid || "");
    } catch (e) {
      return { ok: false, error: `查 aid 失败：${String(e && e.message || e).slice(0, 100)}` };
    }
  }
  if (!aid) return { ok: false, error: "拿不到 aid" };

  const useBv = bvid || sent.bvid || "";

  if (!live) {
    return {
      ok: true,
      mode: "dry-run",
      preview: { url: "https://api.bilibili.com/x/v2/reply/del", oid: aid, rpid: id, csrf: "***" },
      note: `预演：将删除评论 ${id}（${useBv || aid}）。真删需 live=true`,
    };
  }

  try {
    const r = await sdk.network.fetch("https://api.bilibili.com/x/v2/reply/del", {
      method: "POST",
      headers: {
        ...auth.headers(cred),
        origin: "https://www.bilibili.com",
        referer: useBv ? `https://www.bilibili.com/video/${useBv}/` : "https://www.bilibili.com/",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        type: "1", oid: aid, rpid: id, csrf: String(cred.bili_jct),
      }).toString(),
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));

    const OK = j?.code === 0 || j?.code === 12022;   // 12022 = 已经删了
    // 撞风控也要记（之前只 check 不 record，429 了就白撞）
    const rk = OK ? { tripped: false } : risk.record(dataDir, j?.code, { where: "删评论" });
    store.audit(dataDir, {
      action: "retract",
      decision: OK ? "SENT" : "FAIL",
      kind: "comment",
      rpid: id,
      bvid: useBv || null,
      code: j?.code,
      riskTripped: rk.tripped,
    });

    if (j?.code === 0) return { ok: true, mode: "live", rpid: id, note: "已删除" };
    if (j?.code === 12022) return { ok: true, mode: "live", rpid: id, already: true, note: "之前就删过了" };
    return { ok: false, code: j?.code, error: j?.message || `code=${j?.code}`, risk: rk.tripped || undefined };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 150) };
  }
}

/**
 * 删一条自己发的动态。
 * 端点：POST x/dynamic/feed/operate/remove（表单：dynamic_id + csrf）
 */
export async function dynamic(sdk, dataDir, { dynId, live = false, config = {} } = {}) {
  const id = String(dynId || "");
  if (!id) return { ok: false, error: "缺 dynId" };

  if (config.autoPostEnabled !== true) {
    return { ok: false, blocked: true, reason: "kill switch 关闭 → 只读，不删任何东西" };
  }

  const sent = findSent(dataDir, { dynId: id });
  if (!sent) {
    return { ok: false, blocked: true, reason: "审计里没有这条动态的发送记录 —— 不是她发的，不删" };
  }

  const cred = auth.loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没有凭据" };

  if (!live) {
    return {
      ok: true, mode: "dry-run",
      preview: { url: "https://api.bilibili.com/x/dynamic/feed/operate/remove", dynamic_id: id },
      note: `预演：将删除动态 ${id}。真删需 live=true`,
    };
  }

  // 风控进闸（2026-10-20 补：删除动态整条通道之前没接 risk）
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}` };
  }

  try {
    const r = await sdk.network.fetch("https://api.bilibili.com/x/dynamic/feed/operate/remove", {
      method: "POST",
      headers: {
        ...auth.headers(cred),
        origin: "https://t.bilibili.com",
        referer: "https://t.bilibili.com/",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ dynamic_id: id, csrf: String(cred.bili_jct) }).toString(),
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    const OK = j?.code === 0;
    // 撞风控也要记（删除也算写操作）
    const rk = OK ? { tripped: false } : risk.record(dataDir, j?.code, { where: "删动态" });
    store.audit(dataDir, {
      action: "retract", decision: OK ? "SENT" : "FAIL", kind: "dynamic", dynId: id, code: j?.code, riskTripped: rk.tripped,
    });
    if (OK) return { ok: true, mode: "live", dynId: id, note: "已删除" };
    return { ok: false, code: j?.code, error: j?.message || `code=${j?.code}`, risk: rk.tripped || undefined };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 150) };
  }
}

/** 列出她发过、还没收回的东西（给 UI 的「收件箱」用） */
export function sentList(dataDir, limit = 30) {
  const p = path.join(dataDir, "audit.jsonl");
  let lines = [];
  try { lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean); } catch { return []; }

  const sent = [];
  const retracted = new Set();
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.action === "retract" && j.decision === "SENT") {
      if (j.rpid) retracted.add(`c:${j.rpid}`);
      if (j.dynId) retracted.add(`d:${j.dynId}`);
    }
    if (j.decision !== "SENT") continue;
    if (j.action === "publish" && (j.rpid || j.dynId)) sent.push(j);
  }
  return sent
    .filter((j) => !retracted.has(j.rpid ? `c:${j.rpid}` : `d:${j.dynId}`))
    .slice(-limit)
    .reverse();
}
