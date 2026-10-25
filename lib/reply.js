/**
 * lib/reply.js — 她自己回话（P18：C 档）
 *
 * 这是整个 App 最重要的一块，也是最需要克制的。
 *
 * 设计立场：
 *   · **她决定说什么**——判断「这条要不要回」「回什么」是她的脑子（brain）的事
 *   · **代码决定发不发**——闸门是写死的，不交 LLM 裁量
 *   · 两者之间不许有模糊地带
 *
 * 与她「看视频」的区别：
 *   看是读，错了可以重来；回是「先去碰别人」，说出去收不回。
 *   所以回复比分享多一道判断：**这条值不值得回**。
 *
 * 三种结果：
 *   REPLY   发了（或预演通过）
 *   HOLD    闸门认为有风险 → 进待拍板，等人拍
 *   SKIP    她自己决定不回（这是合法结果，不是失败）
 */

import fs from "node:fs";
import path from "node:path";
import * as auth from "./auth.js";
import * as store from "./store.js";
import * as quota from "./quota.js";
import * as gate from "./gate.js";
import * as allowlist from "./allowlist.js";
import * as publish from "./publish.js";

const PENDING = "pending-replies.json";

function readPending(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, PENDING), "utf8"));
    return Array.isArray(j?.items) ? j.items : [];
  } catch { return []; }
}

function writePending(dataDir, items) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, PENDING), JSON.stringify({ items: items.slice(-100) }, null, 2) + "\n");
  } catch { /* 写失败不影响主流程 */ }
}

/**
 * 检查一条「未回」的消息能不能回。
 *
 * 为什么要单独做：收件箱里一条消息可能因为各种原因不该回——
 * 对方是陌生人、已经回过了、话题敏感、超出配额。
 * 这些判断**不该交给模型**，交了就迟早出事。
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export function canReply(dataDir, cfg, item = {}) {
  // ① kill switch
  if (cfg.autoPostEnabled !== true) {
    return { ok: false, reason: "kill switch 关闭 → 只读，不回话" };
  }

  // ② 真发开关（预演时也能走完整流程，只是不真发）
  //    这里不拦预演，交给下层 publish 处理

  // ③ 白名单：只回「找过她的人」
  const scope = Array.isArray(cfg.scope) ? cfg.scope : [];
  if (scope.length === 0) return { ok: false, reason: "白名单为空 → 谁都不回" };

  const target = item.mid ? `uid:${item.mid}` : "";
  if (target) {
    const a = allowlist.allows({ scope, target, dataDir });
    if (!a.allowed) return { ok: false, reason: a.reason };
  }

  // ④ 已经回过这条了吗（按 parent rpid 去重）
  if (item.id) {
    const done = readPending(dataDir).some((x) => x.repliedTo === item.id);
    if (done) return { ok: false, reason: "这条已经回过了" };
  }

  // ④b 同一个人 N 天内只回一次（默认 30，可配）
  //
  // source 仓库写死："同一个人（可选）30 天只回一次"。
  // 我这边之前完全没做——同一个人追着聊，一天能回十次。
  //
  // 主人豁免：对他说话不该被频次拦住，但主人由别的开关管（kill switch + 配额）。
  const coolDays = Number(cfg.sameSomeoneDays ?? 30);
  if (coolDays > 0 && item.mid) {
    const isOwner = String(cfg.ownerMid || "") && String(item.mid) === String(cfg.ownerMid);
    if (!isOwner) {
      const cutoff = Date.now() - coolDays * 86400000;
      const recent = readPending(dataDir).find((x) =>
        String(x.mid || "") === String(item.mid)
        && x.status === "sent"
        && Number(x.sentAt || 0) >= cutoff
      );
      if (recent) {
        const daysAgo = Math.floor((Date.now() - Number(recent.sentAt)) / 86400000);
        return {
          ok: false,
          reason: `这个人 ${daysAgo} 天前回过，${coolDays} 天内不再回（避免追着聊）`,
          cooled: true,
        };
      }
    }
  }

  // ⑤ 缺必要参数就没法回
  if (!item.oid) return { ok: false, reason: "缺 oid，不能回（不是视频评论？）" };

  return { ok: true };
}

/**
 * 发一条回复（或进待拍板）。
 *
 * @param {object} opts
 *   item     收件箱里那一条（要有 oid/root/parent/mid/who/source）
 *   text     她要回的正文（她自己写的）
 *   live     true 才真发
 * @returns {Promise<{ok:boolean, decision:string, reason?:string, rpid?:string}>}
 */
export async function replyTo(sdk, dataDir, cfg, { item = {}, text = "", live = false } = {}) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, decision: "SKIP", reason: "空白正文，不发" };

  // ① 能不能回（确定性规则）
  const can = canReply(dataDir, cfg, item);
  if (!can.ok) return { ok: false, decision: "SKIP", reason: can.reason };

  // ② 五道闸门里的「内容」部分（敏感词 / 长度 / 人身攻击）
  const g = gate.evaluate({ text: body, kind: "comment" }, { newContentType: false });
  const ghits = (g.reasons || []).join("；");
  if (g.decision === "BLOCK") {
    store.audit(dataDir, { action: "reply", decision: "BLOCK", reason: ghits, mid: item.mid, to: item.id });
    return { ok: false, decision: "BLOCK", reason: ghits, hits: g.hits };
  }

  // ③ 配额（按 comment 计）
  const q = quota.check(dataDir, { type: "comment", target: item.mid ? `uid:${item.mid}` : "", config: cfg });
  if (!q.ok) {
    store.audit(dataDir, { action: "reply", decision: "BLOCK", reason: q.reason, mid: item.mid, to: item.id });
    return { ok: false, decision: "BLOCK", reason: q.reason };
  }

  // ④ 敏感 → HOLD，进待拍板（这是 C 档唯一的缓冲）
  if (g.decision === "HOLD") {
    const it = {
      id: `r_${Date.now()}`,
      at: new Date().toISOString(),
      replieTo: item.id,           // 回复的是收件箱哪一条
      mid: item.mid,
      who: item.who,
      source: item.source,
      oid: item.oid,
      root: item.root,
      parent: item.parent,
      text: body,
      reason: ghits || "内容需要人看一眼",
      status: "pending",
    };
    writePending(dataDir, [...readPending(dataDir), it]);
    store.audit(dataDir, { action: "reply", decision: "HOLD", reason: ghits, mid: item.mid, to: item.id });
    return { ok: false, decision: "HOLD", reason: ghits || "进了待拍板", pendingId: it.id };
  }

  // ⑤ 发（或预演）
  const r = await publish.publishComment(sdk, dataDir, {
    oid: item.oid,
    bvid: item.bvid || "",
    message: body,
    root: item.root,
    parent: item.parent,
    type: 1,
    live: live === true && cfg.publishLive === true,
  });

  if (r.ok) {
    quota.record(dataDir, { type: "comment", target: `uid:${item.mid}`, note: "回复", share: false });
    // 记一笔「回过了」，避免同一楼反复回
    writePending(dataDir, [...readPending(dataDir), {
      id: `r_${Date.now()}`,
      at: new Date().toISOString(),
      repliedTo: item.id,
      mid: item.mid,
      who: item.who,
      text: body,
      rpid: r.rpid || null,
      status: r.mode === "live" ? "sent" : "dry",
      // 给「同一人 N 天内只回一次」用（2026-10-20）
      sentAt: r.mode === "live" ? Date.now() : 0,
    }]);
    return { ok: true, decision: "REPLY", rpid: r.rpid, mode: r.mode };
  }

  store.audit(dataDir, { action: "reply", decision: "FAIL", reason: r.hint || r.error, mid: item.mid, to: item.id });
  return { ok: false, decision: "FAIL", reason: r.hint || r.error, code: r.code, mustStop: r.mustStop };
}

/** 列待拍板（等主人拍的回复） */
export function pending(dataDir, status = "pending") {
  const items = readPending(dataDir);
  return status ? items.filter((x) => (x.status || "pending") === status) : items;
}

/** 批准：把待拍板里那条真的发出去 */
export async function approve(sdk, dataDir, cfg, id) {
  const items = readPending(dataDir);
  const it = items.find((x) => x.id === id && (x.status || "pending") === "pending");
  if (!it) return { ok: false, error: "找不到这条待拍板的回复" };

  const r = await publish.publishComment(sdk, dataDir, {
    oid: it.oid,
    bvid: it.bvid || "",
    message: it.text,
    root: it.root,
    parent: it.parent,
    type: 1,
    live: cfg.publishLive === true,
  });

  if (r.ok) {
    const next = items.map((x) => (x.id === id
      ? { ...x, status: r.mode === "live" ? "sent" : "dry", rpid: r.rpid || null, approvedAt: new Date().toISOString() }
      : x));
    writePending(dataDir, next);
    quota.record(dataDir, { type: "comment", target: `uid:${it.mid}`, note: "回复(批准)" });
    return { ok: true, rpid: r.rpid, mode: r.mode };
  }
  return { ok: false, error: r.hint || r.error, code: r.code };
}

/** 驳回：不发，并记下原因（将来喂偏好校准） */
export function reject(dataDir, id, why = "") {
  const items = readPending(dataDir);
  const next = items.map((x) => (x.id === id
    ? { ...x, status: "rejected", rejectedAt: new Date().toISOString(), rejectWhy: String(why).slice(0, 200) }
    : x));
  writePending(dataDir, next);
  return { ok: true, rejected: id };
}
