/**
 * lib/mycomments.js — 她发过什么（P8）
 *
 * 两个来源：
 *   1. **本地审计流**（audit.jsonl）：每次 SENT 都记了 rpid / bvid / dynId
 *      —— 这是我们的账，最可靠，不依赖网络。
 *   2. **B站 回读**：按 mid 查自己最近的评论（`x/v2/reply/main` 不行，
 *      用 `x/v2/reply/wbi/main` 的 member 过滤或空间动态）。
 *      —— 用于发现「发了但没记账成功」的漏网之鱼。
 *
 * 主路径用本地审计；回读作为校验。
 */

import fs from "node:fs";
import path from "node:path";
import { loadCredentials, signedRequest } from "./auth.js";

/**
 * 从本地审计流读已发送记录。
 * @returns {Array<{at, kind, rpid?, dynId?, bvid?, url?}>}
 */
export function fromAudit(dataDir, limit = 100) {
  const p = path.join(dataDir, "audit.jsonl");
  let lines = [];
  try { lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean); }
  catch { return []; }

  const out = [];
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (String(j.decision) !== "SENT") continue;

    // 审计里不同 action 字段不一样：
    //   publish → kind（comment/dynamic）
    //   like / unlike / follow / dm → 没有 kind，之前一律默认成 "comment"（错）
    const act = String(j.action || "");
    let kind;
    if (act === "publish") kind = j.kind || "comment";
    else if (act === "like" || act === "unlike") kind = "like";
    else if (act === "follow") kind = "follow";
    else if (act === "dm") kind = "dm";
    else kind = j.kind || act || "other";

    out.push({
      at: j.at,
      action: act,
      kind,
      rpid: j.rpid || null,
      dynId: j.dynId || null,
      bvid: j.bvid || null,
      mid: j.mid ? String(j.mid) : (j.toMid ? String(j.toMid) : null),
      url: j.bvid && j.rpid
        ? `https://www.bilibili.com/video/${j.bvid}/#reply${j.rpid}`
        : (j.dynId ? `https://t.bilibili.com/${j.dynId}` : null),
      // 本地来源标记
      source: "audit",
    });
  }
  return out.slice(-limit).reverse();
}

/**
 * 从 B站 回读她最近的评论（按 mid）。
 * 用 `x/v2/reply/wbi/main` 拉某个视频的热评，筛出 mid 自己的 —— 但这样要遍历视频。
 * 更可行的是「空间动态」：`x/polymer/web-dynamic/v1/feed/space?host_mid=`。
 * 这里先实现空间动态，能覆盖动态/转发的评论入口。
 *
 * 注意：这不是完整回读（B站 没有「我发过的所有评论」接口），
 * 只是校验本地账本用的旁证。失败就返回空，不阻塞。
 */
export async function fromSpace(sdk, dataDir, { mid = "", limit = 20 } = {}) {
  if (!mid) return { ok: false, items: [], note: "缺 mid" };
  try {
    const json = await signedRequest(
      sdk, dataDir,
      "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space",
      { host_mid: mid, offset: "", timezone_offset: -480, features: "itemOpusStyle" },
      {}, { omitBuvid3: true }
    );
    if (json?.code !== 0) return { ok: false, items: [], note: `code=${json?.code}` };

    const items = (json?.data?.items || []).slice(0, limit).map((it) => {
      const m = it.modules?.module_dynamic || {};
      const desc = m.desc?.text || m.major?.opus?.summary?.text || "";
      const id = it.id_str || String(it.id || "");
      return {
        dynId: id,
        at: it.modules?.module_author?.pub_ts
          ? new Date(it.modules.module_author.pub_ts * 1000).toISOString()
          : null,
        text: String(desc).slice(0, 120),
        url: id ? `https://t.bilibili.com/${id}` : null,
        source: "space",
      };
    }).filter((x) => x.dynId);

    return { ok: true, items };
  } catch (e) {
    return { ok: false, items: [], note: String(e && e.message ? e.message : e) };
  }
}

/**
 * 合并：本地审计为主，空间动态为辅（按 dynId 去重）。
 */
export async function list(sdk, dataDir, { mid = "", limit = 100 } = {}) {
  const local = fromAudit(dataDir, limit);
  const space = await fromSpace(sdk, dataDir, { mid, limit: 20 });
  const seenDyn = new Set(local.map((x) => x.dynId).filter(Boolean));
  const extra = (space.items || []).filter((x) => !seenDyn.has(x.dynId));

  return {
    ok: true,
    total: local.length + extra.length,
    local,
    extra,
    spaceOk: space.ok,
    note: `本地账 ${local.length} 条${extra.length ? ` · 空间补充 ${extra.length} 条` : ""}${space.ok ? "" : `（空间回读：${space.note}）`}`,
  };
}
