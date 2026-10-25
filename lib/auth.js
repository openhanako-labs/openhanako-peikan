/**
 * lib/auth.js — 自持登录态（P1：真实 WBI 签名 + nav 校验）
 *
 * 设计立场：auth 是命门，必须本 App 自持，不读 bilibili-intake 的 cookie、不调其运行时。
 *
 * 凭据文件：<dataDir>/credentials.json
 *   { "sessdata": "...", "bili_jct": "...", "buvid3": "...", "savedAt": "ISO" }
 *   权限尽力收窄；任何日志 / 返回值都不得包含其内容。
 *
 * 网络请求走 sdk.network.fetch（受 manifest network 白名单约束），不裸用 fetch。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CRED_FILE = "credentials.json";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REFERER = "https://www.bilibili.com/";

/** WBI 混淆表（B站前端固定常量） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

export function credPath(dataDir) {
  return path.join(dataDir, CRED_FILE);
}

/** 是否已配置凭据（只回布尔，不回内容） */
export function hasCredentials(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(credPath(dataDir), "utf8"));
    return Boolean(j?.sessdata && j?.bili_jct);
  } catch {
    return false;
  }
}

/** 写入凭据；返回 {ok, missing[]}，永不回显值 */
export function saveCredentials(dataDir, { sessdata, bili_jct, buvid3 } = {}) {
  const missing = [];
  if (!sessdata || !String(sessdata).trim()) missing.push("sessdata");
  if (!bili_jct || !String(bili_jct).trim()) missing.push("bili_jct");
  if (missing.length) return { ok: false, missing };
  fs.mkdirSync(dataDir, { recursive: true });
  const body = {
    sessdata: String(sessdata).trim(),
    bili_jct: String(bili_jct).trim(),
    buvid3: buvid3 ? String(buvid3).trim() : "",
    savedAt: new Date().toISOString(),
  };
  const p = credPath(dataDir);
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows 上不一定生效 */ }
  return { ok: true, missing: [] };
}

/** 读取凭据（仅内部调用；调用方不得把结果写进日志或返回值） */
export function loadCredentials(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(credPath(dataDir), "utf8"));
    if (!j?.sessdata || !j?.bili_jct) return null;
    return { sessdata: j.sessdata, bili_jct: j.bili_jct, buvid3: j.buvid3 || "" };
  } catch {
    return null;
  }
}

/** 构造 Cookie 头（内部用，绝不外传） */
function cookieHeader(cred, opts = {}) {
  const parts = [`SESSDATA=${cred.sessdata}`, `bili_jct=${cred.bili_jct}`];
  // 已知坑（intake SKILL.md）：评论接口 /x/v2/reply/wbi/main 带 buvid3 会被砍回 3 条
  // 所以评论请求必须 omitBuvid3: true。
  if (cred.buvid3 && !opts.omitBuvid3) parts.push(`buvid3=${cred.buvid3}`);
  return parts.join("; ");
}

function baseHeaders(cred, opts = {}) {
  return {
    "user-agent": UA,
    referer: REFERER,
    cookie: cookieHeader(cred, opts),
  };
}

/** 公共头（给需要自己拼请求的模块用，如 likes / frames） */
export function headers(cred, opts = {}) {
  return baseHeaders(cred, opts);
}

/** 从 URL 里抽 wbi 的 key（img/sub 的最后一段去扩展名） */
function keyOf(u) {
  return String(u).slice(u.lastIndexOf("/") + 1, u.lastIndexOf("."));
}

/**
 * 取一次 nav（既校验登录态，也拿 wbi 的 img/sub key）。
 * 返回原始 JSON；失败返回 null。
 */
export async function fetchNav(networkFetch, cred) {
  try {
    const res = await networkFetch("https://api.bilibili.com/x/web-interface/nav", {
      method: "GET",
      headers: baseHeaders(cred),
    });
    const json = typeof res.json === "function" ? await res.json() : JSON.parse(String(res));
    return json;
  } catch {
    return null;
  }
}

/**
 * WBI 签名。返回 { w_rid, wts, mixin } 或 null（拿不到 key）。
 * @param {object} navJson fetchNav 的结果
 * @param {object} params   业务参数
 */
export function wbiSign(navJson, params) {
  const img = navJson?.data?.wbi_img?.img_url;
  const sub = navJson?.data?.wbi_img?.sub_url;
  if (!img || !sub) return null;
  const raw = keyOf(img) + keyOf(sub);
  const mixin = MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
  const wts = Math.round(Date.now() / 1000);
  const clean = (v) => String(v).replace(/[!'()*]/g, "");
  const query = Object.keys({ ...params, wts })
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === "wts" ? wts : params[k]))}`)
    .join("&");
  const w_rid = crypto.createHash("md5").update(query + mixin).digest("hex");
  return { w_rid, wts };
}

/**
 * 登录态校验（真实网络请求）。
 * @param {object} sdk  App sdk（用 sdk.network.fetch）
 * @param {string} dataDir
 * @returns {{ok:boolean, stage:string, detail:string, account?:object}}
 */
export async function verifySession(sdk, dataDir) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, stage: "P1", detail: "未配置凭据" };

  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, stage: "P1", detail: "宿主未提供 network.fetch（检查 manifest network 声明）" };
  }

  const nav = await fetchNav(fetchImpl.bind(sdk.network), cred);
  if (!nav) return { ok: false, stage: "P1", detail: "nav 请求失败（网络或域名白名单）" };

  if (nav.code !== 0 || !nav.data || nav.data.isLogin !== true) {
    const hint =
      nav.code === -101 ? "账号未登录：cookie 失效，需重新登录" :
      nav.code !== 0 ? `nav code=${nav.code} ${nav.message || ""}` :
      "isLogin 为 false";
    return { ok: false, stage: "P1", detail: hint };
  }

  const d = nav.data;
  return {
    ok: true,
    stage: "P1",
    detail: "登录态有效",
    account: {
      uname: d.uname,
      mid: d.mid,
      mobileVerified: d.mobile_verified === 1 || d.mobile_verified === true,
      level: d.level,
      money: d.money,
      wbiKeysReady: Boolean(d.wbi_img?.img_url && d.wbi_img?.sub_url),
    },
  };
}

/**
 * 通用签名请求：自动取 nav → WBI 签名 → 发请求。
 * 供 P2 摄取层使用。
 */
export async function signedRequest(sdk, dataDir, url, params = {}, init = {}, opts = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) throw new Error("未配置凭据");
  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") throw new Error("宿主未提供 network.fetch");

  const nav = await fetchNav(fetchImpl.bind(sdk.network), cred);
  const signed = wbiSign(nav, params);
  const qs = new URLSearchParams(params).toString();
  const full = signed
    ? `${url}?${qs}&w_rid=${signed.w_rid}&wts=${signed.wts}`
    : (qs ? `${url}?${qs}` : url);

  const res = await fetchImpl.call(sdk.network, full, {
    ...init,
    method: init.method || "GET",
    headers: { ...baseHeaders(cred, opts), ...(init.headers || {}) },
  });
  return typeof res.json === "function" ? res.json() : JSON.parse(String(res));
}
