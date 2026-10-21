/**
 * lib/feedback.js — 从主人的话里读出反馈（P21）
 *
 * 为什么不能用关键词：你说「我一般不怎么看这类视频）」，
 * 没有一个负面词，但意思很清楚。关键词匹配读不出来。
 *
 * 所以：**交给她自己（模型）去理解**，但**结构约束是写死的**——
 * 她只能往 taste.json 里写几种确定形状的信号，不能自己发明。
 *
 * 这是「判断交给她、格式交给代码」的又一例。
 *
 * 输出形状（固定）：
 *   { sentiment: "like" | "dislike" | "neutral",
 *     traits: ["时政", "凶案"],
 *     note: "他说的原话大意" }
 */

import * as taste from "./taste.js";
import * as store from "./store.js";

/** 允许的语义值 */
const SENTIMENTS = new Set(["like", "dislike", "neutral"]);
/** 置信度：low 时只观察不动档案 */
const CONFIDENCES = new Set(["high", "medium", "low"]);

/**
 * 从模型返回里抽出结构化的反馈。
 * 模型可能不老实（带 markdown、多说废话），所以这里做**强收敛**。
 */
export function parse(raw) {
  let s = String(raw || "").trim();

  // 去掉可能的 ```json 围栏
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();

  // 找第一个 { ... } 块
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "模型没给 JSON" };

  let j;
  try { j = JSON.parse(s.slice(start, end + 1)); }
  catch { return { ok: false, error: "JSON 解析失败" }; }

  const sentiment = String(j.sentiment || "").toLowerCase();
  if (!SENTIMENTS.has(sentiment)) {
    return { ok: false, error: `sentiment 不合法：${sentiment}` };
  }

  // 置信度：没给就当中等（保守）
  const confRaw = String(j.confidence || "medium").toLowerCase();
  const confidence = CONFIDENCES.has(confRaw) ? confRaw : "medium";

  // traits：最多 3 个，每个 ≤ 8 字，去重去空
  const rawTraits = Array.isArray(j.traits) ? j.traits : [];
  const traits = [...new Set(
    rawTraits
      .map((x) => String(x || "").trim())
      .filter((x) => x && x.length <= 8),
  )].slice(0, 3);

  return {
    ok: true,
    sentiment,
    confidence,
    traits,
    note: String(j.note || "").slice(0, 160),
  };
}

/**
 * 把一次解析结果落到口味档案。
 *
 * @param {object} ctx   App ctx（要用 models）
 * @param {string} who   "owner" | "mine"
 * @param {object} fb    parse() 的结果
 */
export function apply(dataDir, who, fb = {}) {
  if (!fb.ok) return { ok: false, error: fb.error };
  if (fb.sentiment === "neutral" || !fb.traits.length) {
    return { ok: true, applied: 0, reason: "中性或无主题词，不改口味" };
  }

  // low 置信度：只记观察，不动权重。
  // 为什么：猜错主题词比不猜更糟——会把错误写在档案上。
  if (fb.confidence === "low") {
    return {
      ok: true, applied: 0,
      reason: `置信度低，只记录不调权重（猜的是 ${fb.traits.join("/")}）`,
      observed: { traits: fb.traits, sentiment: fb.sentiment, note: fb.note },
    };
  }

  const delta = fb.sentiment === "like" ? 1 : -1;
  const applied = [];

  for (const t of fb.traits) {
    const r = taste.touch(dataDir, t, { side: who, delta, note: fb.note });
    if (r.ok) applied.push({ trait: t, now: r.now });
  }

  return { ok: true, applied: applied.length, traits: applied, sentiment: fb.sentiment, confidence: fb.confidence };
}

/**
 * 从她现有的材料里抽「候选主题词」。
 *
 * 为什么需要：开放式猜测实测失败（模型不敢定词）。
 * 改成「从已知选项里选」——这是降低任务难度的最直接办法。
 *
 * 来源三个：
 *   ① 口味档案里已经有的话题（她/他表态过的）
 *   ② config 里的 like / dislike 词条
 *   ③ 最近笔记里出现得多的短词
 */
export function candidatesFrom(dataDir, cfg = {}, { limit = 8 } = {}) {
  const out = new Set();

  // ① 已有档案
  try {
    const s = taste.snapshot(dataDir, { limit: 30 });
    for (const r of s.rows) out.add(r.trait);
  } catch { /* 忽略 */ }

  // ② 配置里的好恶词条
  for (const k of [...(cfg.like || []), ...(cfg.dislike || [])]) {
    const v = String(k || "").trim();
    if (v && v.length <= 8) out.add(v);
  }

  // ③ 最近笔记里带「·」分隔的 marks（她自己标过的点）
  try {
    const notes = store.listNotes(dataDir, 40);
    for (const n of notes) {
      for (const m of (n.marks || [])) {
        const v = String(m || "").trim();
        if (v && v.length >= 2 && v.length <= 6) out.add(v);
      }
    }
  } catch { /* 忽略 */ }

  return [...out].slice(0, limit);
}

/**
 * 整条链：拿到主人一句话 → 让模型理解 → 落进档案。
 *
 * @param {object} sdk    App ctx
 * @param {object} opts
 *   text     主人说的话
 *   context  上下文（之前聊了什么）
 *   thinker  可选：注入的「思考函数」（测试用），签名 (prompt) => Promise<string>
 */
export async function digest(sdk, dataDir, opts = {}) {
  const text = String(opts.text || "").trim();
  if (!text) return { ok: false, error: "没有内容可分析" };

  // 候选主题词：从上下文/笔记里抽出来的
  //
  // 为什么要有这个（2026-10-20 实测）：开放式的「你猜是哪类」模型答不上来，
  // 两次实测都判成 low / neutral，因为「这类」本身就需要指代消解。
  // 改成闭合选项后，它只需要做选择题。
  const cands = Array.isArray(opts.candidates)
    ? [...new Set(opts.candidates.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 8)
    : [];

  const prompt = [
    "这段话是主人对我（一个在 B站 上看内容的助手）说的。",
    "请判断他对「某类内容」的态度，然后用 JSON 回答。",
    "",
    "【他说的话】",
    text,
    "",
    opts.context ? `【之前聊的】${String(opts.context).slice(0, 500)}` : "",
    "",
    cands.length
      ? [
        "【候选主题词】（只能从这里面选，不要自己造）",
        cands.map((c, i) => `${i + 1}. ${c}`).join("  "),
        "",
        "「这类」指的是：刚刚聊的那条内容，从上面候选里选最贴的。",
        "如果候选里真的没一个贴得上，traits 才留空数组。",
      ].join("\n")
      : [
        "【没有候选主题词】",
        "如果上下文能看出是哪类内容，写出类型；看不出来就留空。",
      ].join("\n"),
    "",
    "【输出格式，只要 JSON，不要别的】",
    '{"sentiment":"like|dislike|neutral","traits":["主题词"],"confidence":"high|medium|low","note":"他的意思，一句话"}',
    "",
    "规则：",
    "- traits 是内容类型（时政/凶案/鬼畜/猫咪/游戏实况…），不是情绪。",
    "- 每个主题词 ≤ 8 字，最多 2 个。",
    "",
    "- **语气委婉但意思明确时，sentiment 要照实判**：",
    "  「我一般不怎么看这类视频）」= dislike（委婉的拒绝），不是 neutral。",
    "  「还行吧」「就那样」这类无态度的才用 neutral。",
    "",
    "- confidence：他明说了类型=high；从上下文推出来=medium；只能猜=low。",
    "  有候选主题词且能对上 → 至少 medium。",
    "",
    "- 只有真的寒暄、无可指代（「在吗」「今天好吗」）→ neutral + 空 traits",
  ].filter(Boolean).join("\n");

  let raw;
  try {
    if (typeof opts.thinker === "function") {
      raw = await opts.thinker(prompt);
    } else {
      // 用 App 自己的脑子（不建会话）
      //
      // 用 ask 而不是 think：think 是为工具循环设计的，
      // 空 tools 会让模型进入「下一步要调什么工具」的思维模式，
      // 实测会干扰 JSON 输出的稳定性（2026-10-20）。
      const brain = await import("./brain.js");
      const r = await brain.ask(sdk, dataDir, {
        prompt,
        systemPrompt: "你只输出 JSON，不解释，不加 markdown 围栏。",
        maxTokens: 1200,   // 推理模型要给足
        temperature: 0.3,
      });
      if (!r.ok) return { ok: false, error: r.error };
      raw = r.text;
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 150) };
  }

      const fb = parse(raw);
      if (!fb.ok) {
        store.audit(dataDir, { action: "feedback", decision: "SKIP", reason: fb.error });
        return { ok: false, error: fb.error, raw: String(raw).slice(0, 200) };
      }

      const res = apply(dataDir, opts.who || "owner", fb);
      store.audit(dataDir, {
        action: "feedback",
        decision: "APPLIED",
        who: opts.who || "owner",
        sentiment: fb.sentiment,
        traits: fb.traits,
      });
      return {
        ok: true, ...res,
        understood: fb,
        // 调试：默认不带，传 debug 才回显（排查「模型到底看见了什么」用）
        ...(opts.debug ? { _prompt: prompt, _raw: String(raw).slice(0, 500) } : {}),
      };
}
