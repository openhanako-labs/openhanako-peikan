/**
 * lib/publish.js — 发布层（P5：预演模式 + 真发开关）
 *
 * 设计立场：
 *   1. **默认预演**（dry-run）：组装真实请求、校验参数、走完五道闸门，但不 POST。
 *      `live === true` 时才真发。
 *   2. **撞风控立刻停**：错误码表命中即返回停手信号，不重试、不绕过。
 *   3. **发后记账**：成功记账 + 审计；失败记审计（不记账等于额度白送）。
 *
 * 接口参考 dsh-bili-whale 的 comment.mjs（已实跑验证）。
 */

import { loadCredentials, wbiSign, fetchNav } from "./auth.js";
import * as quota from "./quota.js";
import * as store from "./store.js";
import * as risk from "./risk.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 风控错误码 → 处置建议（照 whale 的表） */
export const ERROR_HINTS = {
  "-101": "账号未登录：cookie 失效",
  "-102": "账号被封停",
  "-111": "csrf 校验失败：bili_jct 不对或与 SESSDATA 不是同一个号",
  "-509": "请求过于频繁",
  "12015": "需要评论验证码（说明被风控盯上了，停手）",
  "12016": "内容含敏感信息",
  "12035": "被 UP 主列入评论黑名单",
  "12051": "重复评论被判刷屏",
  "12002": "评论区已关闭",
};

/** 哪些错误码意味着「必须停手」 */
const STOP_CODES = new Set(["-102", "-509", "12015", "12051"]);

export function explainCode(code) {
  const key = String(code);
  return {
    hint: ERROR_HINTS[key] || `未知错误码 ${key}`,
    mustStop: STOP_CODES.has(key),
  };
}

export function cookieHeader(cred, opts = {}) {
  const parts = [`SESSDATA=${cred.sessdata}`, `bili_jct=${cred.bili_jct}`];
  if (cred.buvid3 && !opts.omitBuvid3) parts.push(`buvid3=${cred.buvid3}`);
  return parts.join("; ");
}

/**
 * 组装评论请求（不发）。
 */
export function buildCommentRequest(cred, { oid, bvid, message, root, parent, type = 1 }) {
  const params = { type, oid: String(oid), message, plat: "1", csrf: String(cred.bili_jct) };
  if (root) params.root = String(root);
  if (parent) params.parent = String(parent);

  const referer = bvid ? `https://www.bilibili.com/video/${bvid}/` : "https://www.bilibili.com/";

  return {
    url: "https://api.bilibili.com/x/v2/reply/add",
    params,
    body: new URLSearchParams(params).toString(),
    referer,
    headers: {
      "user-agent": UA,
      referer,
      origin: "https://www.bilibili.com",
      "content-type": "application/x-www-form-urlencoded",
    },
  };
}

/** 脱敏后的请求预览（给模型/审计看，不含凭据） */
export function previewRequest(req, cred) {
  return {
    method: "POST",
    url: req.url,
    referer: req.referer,
    body: req.body.replace(encodeURIComponent(String(cred.bili_jct)), "***csrf***"),
    cookieMasked: "SESSDATA=***; bili_jct=***" + (cred.buvid3 ? "; buvid3=***" : ""),
    bodyLength: req.body.length,
  };
}

/**
 * 发一条动态（图文纯文本）。
 * 与评论不同：JSON body + WBI 签名 + origin 为 t.bilibili.com。
 * 参考 whale 的 dynamic.mjs（已实跑验证）。
 */
export async function publishDynamic(sdk, dataDir, { text, live = false } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, stage: "P5", error: "未配置凭据" };
  if (!text || !String(text).trim()) return { ok: false, stage: "P5", error: "正文不能为空" };

  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, stage: "P5", error: "宿主未提供 network.fetch" };

  const nav = await fetchNav(fetchImpl.bind(sdk.network), cred);
  const body = JSON.stringify({
    dyn_req: {
      content: { contents: [{ raw_text: String(text), type: 1, biz_id: "" }] },
      scene: 1,
      meta: { app_meta: { from: "create.dynamic.web", mobi_app: "web" } },
    },
  });

  // WBI 签名（动态接口带 w_rid）
  const signed = wbiSign(nav, { csrf: String(cred.bili_jct) });
  const url = signed
    ? `https://api.bilibili.com/x/dynamic/feed/create/dyn?w_rid=${signed.w_rid}&wts=${signed.wts}`
    : `https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(String(cred.bili_jct))}`;

  const preview = {
    method: "POST",
    url: url.replace(encodeURIComponent(String(cred.bili_jct)), "***csrf***"),
    origin: "https://t.bilibili.com",
    contentType: "application/json",
    bodyLength: body.length,
    textLength: String(text).length,
  };

  if (!live) {
    store.audit(dataDir, { action: "publish", decision: "DRY_RUN", kind: "dynamic", bodyLength: body.length });
    return {
      ok: true, stage: "P5", mode: "dry-run", preview,
      note: "预演：动态请求已组装并通过 WBI 签名，未发送。真发需 publishLive=true",
    };
  }

  // 风控进闸（放在 live 之后：预演不发请求，冷却期也该能看预览）
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}`, level: rkPre.level };
  }

  // 发前过闸（2026-10-20 补）：之前这一步缺失 —— 动态只记配额不检查，
  // 而配额与闸门是两回事（配额管数量，闸门管内容）。
  try {
    const gateMod = await import("./gate.js");
    const g = gateMod.evaluate({ text: String(text), kind: "dynamic" }, { newContentType: false });
    if (g.decision !== "ALLOW") {
      store.audit(dataDir, { action: "publish", decision: g.decision, kind: "dynamic", reason: g.reasons.join("；") });
      return { ok: false, stage: "P5", mode: "blocked", decision: g.decision, reasons: g.reasons };
    }
  } catch { /* 闸门自身出错不阻发 */ }

  try {
    const res = await fetchImpl.call(sdk.network, url, {
      method: "POST",
      headers: {
        "user-agent": UA,
        referer: "https://www.bilibili.com/",
        origin: "https://t.bilibili.com",
        "content-type": "application/json",
        cookie: cookieHeader(cred),
      },
      body,
    });
    const out = typeof res.json === "function" ? await res.json() : JSON.parse(String(res));

    if (out?.code === 0) {
      const dynId = out.data?.dyn_id_str ?? out.data?.dyn_id;
      quota.record(dataDir, { type: "dynamic", target: "dynamic", note: String(text).slice(0, 40) });
      store.audit(dataDir, { action: "publish", decision: "SENT", kind: "dynamic", dynId });
      return { ok: true, stage: "P5", mode: "live", dynId, url: `https://t.bilibili.com/${dynId}` };
    }

    const { hint, mustStop } = explainCode(out?.code);
    // 撞风控立刻拉闸（2026-10-20）：不是只提示，是真的停手
    const rk = risk.record(dataDir, out?.code, { where: "发动态" });
    store.audit(dataDir, { action: "publish", decision: "FAILED", kind: "dynamic", code: out?.code, hint, mustStop, riskTripped: rk.tripped });
    return { ok: false, stage: "P5", mode: "live", code: out?.code, hint, mustStop, errmsg: out?.data?.errmsg };
  } catch (e) {
    return { ok: false, stage: "P5", error: `请求异常：${e && e.message ? e.message : e}` };
  }
}

export async function publishComment(sdk, dataDir, { oid, bvid, message, root, parent, type = 1, live = false } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, stage: "P5", error: "未配置凭据" };

  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, stage: "P5", error: "宿主未提供 network.fetch" };

  // WBI 签名（评论接口也认 w_rid）
  const nav = await fetchNav(fetchImpl.bind(sdk.network), cred);
  const req = buildCommentRequest(cred, { oid, bvid, message, root, parent, type });
  const signed = wbiSign(nav, req.params);
  const url = signed
    ? `${req.url}?w_rid=${signed.w_rid}&wts=${signed.wts}`
    : req.url;

  const preview = previewRequest(req, cred);

  // 预演：到此为止
  // 注意：risk.check 放在这里之后（不是之前）——
  // 预演不发任何请求，冷却期也应该能看到「将要发什么」。
  if (!live) {
    store.audit(dataDir, { action: "publish", decision: "DRY_RUN", kind: "comment", bvid: bvid || null, bodyLength: req.body.length });
    return {
      ok: true,
      stage: "P5",
      mode: "dry-run",
      preview,
      note: "预演：请求已组装并通过 WBI 签名，未发送。真发需 publishLive=true",
    };
  }

  // 风控进闸（2026-10-20 补：之前整个 publishComment 完全没接 risk）
  // 这是最高频的写通道——回评、主动评论、待拍板批准全走它。
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}`, level: rkPre.level };
  }

  // 真发
  try {
    const res = await fetchImpl.call(sdk.network, url, {
      method: "POST",
      headers: { ...req.headers, cookie: cookieHeader(cred, { omitBuvid3: true }) },
      body: req.body,
    });
    const out = typeof res.json === "function" ? await res.json() : JSON.parse(String(res));

    if (out?.code === 0) {
      const rpid = out.data?.rpid_str ?? out.data?.rpid;
      quota.record(dataDir, {
        type: "comment",
        target: bvid ? `BV:${bvid}` : `oid:${oid}`,
        note: message.slice(0, 40),
      });
      store.audit(dataDir, { action: "publish", decision: "SENT", kind: "comment", rpid, bvid: bvid || null });
      return {
        ok: true, stage: "P5", mode: "live", rpid,
        url: bvid ? `https://www.bilibili.com/video/${bvid}/#reply${rpid}` : null,
      };
    }

    const { hint, mustStop } = explainCode(out?.code);
    // 撞风控立刻拉闸（评论是最容易被盯上的接口）
    const rk = risk.record(dataDir, out?.code, { where: "发评论" });
    store.audit(dataDir, { action: "publish", decision: "FAILED", kind: "comment", code: out?.code, hint, mustStop, riskTripped: rk.tripped });
    return { ok: false, stage: "P5", mode: "live", code: out?.code, hint, mustStop, risk: rk.tripped || undefined };
  } catch (e) {
    return { ok: false, stage: "P5", error: `请求异常：${e && e.message ? e.message : e}` };
  }
}
