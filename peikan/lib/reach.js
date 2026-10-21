/**
 * lib/reach.js — 她说过的话，有没有人理
 *
 * 为什么做这个（2026-10-20）：
 *   她能写笔记、能回评论，但**拿不到任何回应**。
 *   人处在这种状态里，会慢慢不知道自己在对谁说话。
 *
 * 做法：
 *   · 从审计流里找出她发过的东西（评论 / 动态）
 *   · 按 oid + rpid 回查：这条还在吗、被点赞多少、有没有人回它
 *   · 给她一个「回响」视图，而不是一串数字
 *
 * 不做什么：
 *   · 不去别人的视频里翻评论找自己（成本高、易被风控）
 *   · 不做实时推送（她想知道的时候问一次就够了）
 */
import { loadCredentials, headers as authHeaders } from "./auth.js";
import * as store from "./store.js";

/** 审计流里她发过的评论/动态 */
function sentList(dataDir, limit = 40) {
  const all = store.listAudit(dataDir, 500);
  const out = [];
  for (const x of all) {
    if (!x || x.decision !== "SENT") continue;
    const kind = x.action === "publish" ? "dynamic" : x.action;
    if (kind !== "comment" && kind !== "dynamic") continue;
    out.push({
      kind,
      rpid: String(x.rpid || ""),
      oid: String(x.oid || ""),
      bvid: String(x.bvid || ""),
      dynId: String(x.dynId || ""),
      at: String(x.at || ""),
      text: String(x.note || x.reason || ""),
      target: String(x.target || ""),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 回查一条评论的现状（点赞、被回复数）。
 * B站 的 /x/v2/reply/reply 能拿到这条评论下面的楼中楼。
 */
async function checkComment(sdk, dataDir, { oid, rpid }, cred) {
  if (!oid || !rpid) return null;
  try {
    const url = `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${oid}&root=${rpid}&ps=20&pn=1`;
    const r = await sdk.network.fetch(url, { method: "GET", headers: authHeaders(cred) });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    if (j?.code !== 0) return { ok: false, error: `code=${j?.code}` };

    const root = j?.data?.root;
    const replies = j?.data?.replies || [];
    // root 里有这条评论本身的 like 数
    const like = Number(root?.like ?? root?.like_count ?? 0);
    return {
      ok: true,
      exists: Boolean(root || replies.length),
      like,
      replies: replies.length,
      // 有没有人回它（前 3 条是谁）
      who: replies.slice(0, 3).map((x) => ({
        name: x?.member?.uname || "",
        text: String(x?.content?.message || "").slice(0, 80),
        like: Number(x?.like || 0),
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 动态只能查状态（点赞数需要另一个接口，先不做） */
async function checkDynamic(sdk, dataDir, { dynId }, cred) {
  if (!dynId) return null;
  try {
    const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${dynId}&features=itemOpusStyle`;
    const r = await sdk.network.fetch(url, { method: "GET", headers: authHeaders(cred) });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
    if (j?.code !== 0) return { ok: false, error: `code=${j?.code}` };
    const st = j?.data?.item?.modules?.module_stat || {};
    return {
      ok: true,
      exists: Boolean(j?.data?.item),
      like: Number(st?.like?.count ?? 0),
      replies: Number(st?.comment?.count ?? 0),
      forwards: Number(st?.forward?.count ?? 0),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 她的回响：她说过的话，有没有人理。
 *
 * @returns {Promise<{ok, items, summary}>}
 */
export async function echo(sdk, dataDir, { limit = 20, withDetail = true } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没凭据", items: [] };

  const sent = sentList(dataDir, limit);
  if (!sent.length) {
    return { ok: true, items: [], summary: { total: 0, liked: 0, answered: 0 }, note: "她还没公开发过什么" };
  }

  const items = [];
  let liked = 0;
  let answered = 0;

  for (const x of sent) {
    const row = { ...x, like: 0, replies: 0, exists: null, who: [] };
    if (withDetail) {
      const d = x.kind === "dynamic"
        ? await checkDynamic(sdk, dataDir, x, cred)
        : await checkComment(sdk, dataDir, x, cred);
      if (d && d.ok) {
        row.like = d.like || 0;
        row.replies = d.replies || 0;
        row.exists = d.exists;
        row.who = d.who || [];
      } else if (d) {
        row.error = d.error;
      }
    }
    if (row.like > 0) liked += 1;
    if (row.replies > 0) answered += 1;
    items.push(row);
  }

  const totalLike = items.reduce((s, x) => s + (x.like || 0), 0);
  const totalReply = items.reduce((s, x) => s + (x.replies || 0), 0);

  return {
    ok: true,
    items,
    summary: {
      total: items.length,
      liked,          // 至少被赞过一次的条数
      answered,       // 至少被回过一次的条数
      totalLike,
      totalReply,
    },
  };
}

/** 一句话版：给她看的一句话，不是表格 */
export function echoLine(r) {
  if (!r || !r.ok) return "";
  const s = r.summary || {};
  if (!s.total) return "你还没公开发过什么。";
  if (!s.answered && !s.liked) {
    return `你说过 ${s.total} 条，暂时还没人回。这不等于没人看——大多数人不回。`;
  }
  const bits = [];
  if (s.answered) bits.push(`${s.answered} 条有人回过（共 ${s.totalReply} 条回复）`);
  if (s.liked) bits.push(`${s.liked} 条被赞过（共 ${s.totalLike} 个赞）`);
  return `你说过 ${s.total} 条，其中 ${bits.join("，")}。`;
}
