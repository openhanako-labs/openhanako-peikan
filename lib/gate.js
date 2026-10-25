/**
 * lib/gate.js — 发布决策闸门（确定性，写死）
 *
 * 立场：放行判定不交给运行时 LLM 裁量。输入是草稿对象，输出是
 *   { decision: "ALLOW" | "HOLD" | "BLOCK", reasons: string[], hits: string[] }
 * 规则全部是确定性比对，无模型参与。
 *
 * 对应 02-publish-gate-rules.md。
 */

/** 身份隔离词表（占位，实施时补全并支持外部文件） */
const IDENTITY_TERMS = [
  // 真实姓名 / 住址 / 单位 / 手机号 等由用户提供后填入外部词表；
  // 这里只放结构性占位，避免把真实信息写进代码。
  "身份证", "手机号", "住址", "工作单位",
];

/** 风控高危词（占位） */
const RISK_TERMS = [
  "代刷", "刷量", "返利", "引流加微信", "兼职日结",
];

const SENSITIVE_TOPICS = [
  "政治", "时政", "防疫", "战争",
];

/** 简单的真实信息模式：11 位手机号、18 位身份证 */
const PHONE_RE = /\b1[3-9]\d{9}\b/;
const ID_CARD_RE = /\b\d{17}[\dXx]\b/;

/**
 * @param {object} draft { text, kind: "comment"|"dynamic"|"dm", targetBv?, via? }
 * @param {object} options { newContentType?: boolean }
 */
export function evaluate(draft, options = {}) {
  const text = String(draft?.text ?? "");
  const reasons = [];
  const hits = [];

  // 1) 硬拦：真实信息
  if (PHONE_RE.test(text)) { hits.push("phone-like"); reasons.push("疑似手机号"); }
  if (ID_CARD_RE.test(text)) { hits.push("idcard-like"); reasons.push("疑似身份证号"); }
  for (const t of IDENTITY_TERMS) {
    if (t && text.includes(t)) { hits.push(`identity:${t}`); reasons.push(`命中身份隔离词：${t}`); }
  }
  if (hits.length) {
    return { decision: "BLOCK", reasons, hits };
  }

  // 2) 硬拦：风控高危
  for (const t of RISK_TERMS) {
    if (t && text.includes(t)) { hits.push(`risk:${t}`); reasons.push(`命中风控高危词：${t}`); }
  }
  if (hits.length) {
    return { decision: "BLOCK", reasons, hits };
  }

  // 3) 转人审：敏感话题
  for (const t of SENSITIVE_TOPICS) {
    if (t && text.includes(t)) { hits.push(`topic:${t}`); reasons.push(`触及敏感话题：${t}`); }
  }

  // 4) 转人审：首次尝试的新内容形态
  if (options.newContentType) { hits.push("new-content-type"); reasons.push("新内容形态，首条需人审"); }

  // 5) 转人审：空正文
  if (!text.trim()) { hits.push("empty"); reasons.push("正文为空"); }

  if (hits.length) {
    return { decision: "HOLD", reasons, hits };
  }

  return { decision: "ALLOW", reasons: ["通过确定性规则"], hits: [] };
}

/**
 * 写通道的统一入口（2026-10-20 加）
 *
 * 由来：参考原仓库 quota-gate.mjs 的教训 ——
 *   「quota.mjs 承诺 check 只挡发言类动作，但 dynamic / danmaku 四条写通道里
 *      quota 出现 0 次 —— 等于裸奔」
 *
 * 我这边同样的问题：reply / publish / likes 过了闸门，
 * 但 social（私信）/ share / retract 全裸。私信还是直接发给主人的。
 *
 * 这个函数把「闸门 + 配额 + 审计」收成一次调用，任何写通道都必须走它。
 */
export function check(dataDir, store, quota, { kind, text, target = "", via = "", config = {}, newContentType = false } = {}) {
  // ① 确定性闸门
  const g = evaluate({ text, kind, targetBv: target, via }, { newContentType });

  if (g.decision === "BLOCK") {
    try { store.audit(dataDir, { action: kind, decision: "BLOCK", reason: g.reasons.join("；"), target }); } catch { /* 忽略 */ }
    return { ok: false, decision: "BLOCK", reasons: g.reasons, hits: g.hits };
  }
  if (g.decision === "HOLD") {
    try { store.audit(dataDir, { action: kind, decision: "HOLD", reason: g.reasons.join("；"), target }); } catch { /* 忽略 */ }
    return { ok: false, decision: "HOLD", reasons: g.reasons, hits: g.hits };
  }

  // ② 配额（私信也计，否则它就是一个无限接口）
  if (quota) {
    const q = quota.check(dataDir, { type: kind, target, config });
    if (q && q.ok === false) {
      try { store.audit(dataDir, { action: kind, decision: "BLOCK", reason: q.reason || "配额不足", target }); } catch { /* 忽略 */ }
      return { ok: false, decision: "BLOCK", reasons: [q.reason || "配额不足"], quota: q };
    }
  }

  return { ok: true, decision: "ALLOW", reasons: g.reasons };
}

/** 发成功之后记账（失败不记） */
export function record(dataDir, store, quota, { kind, target = "", note = "", share = false } = {}) {
  try {
    if (quota) quota.record(dataDir, { type: kind, target, note, share });
  } catch { /* 配额记账失败不影响已经发出去的 */ }
  try {
    store.audit(dataDir, { action: kind, decision: "SENT", target, note: String(note).slice(0, 60) });
  } catch { /* 忽略 */ }
  return { ok: true };
}
