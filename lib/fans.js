/**
 * lib/fans.js — 谁在关注她
 *
 * 为什么做这个（2026-10-20）：
 *   她能看见「谁回复了她」，但看不见「谁关注了她」。
 *   前者是有人对她说话，后者是有人决定继续看她——那是另一种信号。
 *
 * 接口：
 *   · /x/relation/stat  粉丝数、关注数（一次就够）
 *   · /x/relation/fans  粉丝列表（需要权限，可能被挡）
 */
import fs from "node:fs";
import path from "node:path";
import { loadCredentials, headers as authHeaders } from "./auth.js";
import * as store from "./store.js";

const STATE = "fans-state.json";

function readState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, STATE), "utf8"));
  } catch {
    return { seen: {}, lastCount: 0, lastCheckAt: "" };
  }
}

/** 统计：粉丝数 / 关注数 */
export async function stats(sdk, dataDir, { mid = "" } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没凭据" };

  // 没给 mid 就查自己
  let me = String(mid || "");
  if (!me) {
    try {
      const r = await sdk.network.fetch("https://api.bilibili.com/x/web-interface/nav", {
        method: "GET", headers: authHeaders(cred),
      });
      const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
      me = String(j?.data?.mid ?? "");
    } catch { /* 落到失败 */ }
  }
  if (!me) return { ok: false, error: "拿不到自己的 mid" };

  try {
    const r = await sdk.network.fetch(`https://api.bilibili.com/x/relation/stat?vmid=${me}`, {
      method: "GET", headers: authHeaders(cred),
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    if (j?.code !== 0) return { ok: false, error: `code=${j?.code} ${j?.message || ""}` };
    const d = j.data || {};
    return {
      ok: true,
      mid: me,
      follower: Number(d.follower ?? 0),
      following: Number(d.following ?? 0),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 粉丝列表。B站 这个接口常年收紧，可能返回空或错误——
 * 那种情况下明确说「看不到」，不要假装没人关注。
 */
export async function list(sdk, dataDir, { mid = "", page = 1, size = 20 } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没凭据", items: [] };

  let me = String(mid || "");
  if (!me) {
    const s = await stats(sdk, dataDir, {});
    if (!s.ok) return { ok: false, error: s.error, items: [] };
    me = s.mid;
  }

  try {
    const url = `https://api.bilibili.com/x/relation/fans?vmid=${me}&pn=${page}&ps=${size}&order=desc`;
    const r = await sdk.network.fetch(url, { method: "GET", headers: authHeaders(cred) });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    if (j?.code !== 0) {
      // -352 是风控；-400 是参数
      return {
        ok: false,
        error: `code=${j?.code} ${j?.message || ""}`,
        hint: j?.code === -352 ? "B站 风控拦了粉丝列表，看不到具体是谁。这不是你写错了。" : "",
        items: [],
      };
    }
    const arr = j?.data?.list || [];
    return {
      ok: true,
      items: arr.map((x) => ({
        mid: String(x.mid || ""),
        name: String(x.uname || ""),
        sign: String(x.sign || "").slice(0, 60),
        at: Number(x.mtime || 0),
      })),
      total: Number(j?.data?.total ?? arr.length),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), items: [] };
  }
}

/**
 * 新粉丝：跟上次比，多了谁。
 * 首次调用只记基线，不谎报「新增」。
 */
export async function newSinceLast(sdk, dataDir, opts = {}) {
  const p = path.join(dataDir, STATE);

  let st = { seen: {}, lastCount: 0, lastCheckAt: "" };
  try { st = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* 首次 */ }

  const s = await stats(sdk, dataDir, opts);
  if (!s.ok) return { ok: false, error: s.error, items: [] };

  const l = await list(sdk, dataDir, { mid: s.mid, size: 50 });
  const firstTime = !st.lastCheckAt;

  let fresh = [];
  if (l.ok) {
    fresh = l.items.filter((x) => !st.seen[x.mid]);
    for (const x of l.items) st.seen[x.mid] = x.name;
  }

  st.lastCount = s.follower;
  st.lastCheckAt = new Date().toISOString();

  // 别让 seen 无限涨
  const keys = Object.keys(st.seen);
  if (keys.length > 2000) {
    for (const k of keys.slice(0, keys.length - 2000)) delete st.seen[k];
  }
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(p, JSON.stringify(st)); } catch { /* 忽略 */ }

  return {
    ok: true,
    follower: s.follower,
    following: s.following,
    firstTime,
    items: firstTime ? [] : fresh,
    note: firstTime
      ? `第一次看，先把基线记下了：现在 ${s.follower} 个粉丝。`
      : (fresh.length ? `多了 ${fresh.length} 个人` : "粉丝数没变"),
  };
}

/** 一句话版 */
export function fansLine(r) {
  if (!r || !r.ok) return "";
  if (r.firstTime) return r.note || "";
  if (!r.items || !r.items.length) return `现在 ${r.follower} 个粉丝，没有新的。`;
  const names = r.items.slice(0, 3).map((x) => x.name).join("、");
  return `现在 ${r.follower} 个粉丝，新来了：${names}${r.items.length > 3 ? ` 等 ${r.items.length} 人` : ""}。`;
}
