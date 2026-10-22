/**
 * lib/brain.js — 她的脑子（P9）
 *
 * App 自己调模型，不建会话、不占主界面。
 *   · 模型：从选中的 agent 读配置；读不到就用宿主默认
 *   · 人格：dataDir/persona.md → systemPrompt
 *   · 工具：App 自己执行（模型只发 toolCall，我们跑完塞回 toolResult）
 *
 * 为什么不用会话：她要的是「在后台过日子」，不是「跟人对话」。
 * 会话会出现在你的列表里、吃你的上下文；这里全程在 App 内。
 *
 * 两个入口：
 *   ask()       —— 纯文本问答（最简单，用于验证链路）
 *   think()     —— 带工具循环（用于真的"看一条视频然后判断"）
 */

import fs from "node:fs";
import path from "node:path";
import { readPersona, readSelection, agentModel, resolvePersona } from "./identity.js";

const MAX_TOOL_ROUNDS = 6;   // 工具循环硬上限，防无限转（拉流+深读+写笔记+总结 ≈ 4-5 轮）

/**
 * 解析 NDJSON 流，收集文本 + 工具调用。
 */
async function consumeStream(res) {
  const text = [];
  const reasoning = [];
  const toolCalls = [];
  let usage = null;
  let error = null;
  // 排障用：记录出现过的事件类型 + 前几个样本（不看内容就不知道对面在发什么）
  const seen = Object.create(null);
  const samples = [];
  const note = (ev) => {
    const t = ev && typeof ev === "object" ? String(ev.type || "(无 type)") : typeof ev;
    seen[t] = (seen[t] || 0) + 1;
    if (samples.length < 6) {
      try { samples.push(JSON.stringify(ev).slice(0, 400)); } catch { samples.push(String(ev)); }
    }
  };

  if (!res || typeof res.body === "undefined") {
    // 有些实现直接返回 JSON
    const j = typeof res.json === "function" ? await res.json() : res;
    // 有些直接返回 { text } / { content } / 字符串
    const t = j?.text ?? j?.content ?? (typeof j === "string" ? j : "");
    return {
      text: String(t || ""),
      toolCalls: [],
      usage: null,
      error: null,
      seen: { "(无body)": 1 },
      samples: [
        "resKeys=" + (res && typeof res === "object" ? Object.keys(res).join(",") : typeof res),
        "jsonKeys=" + (j && typeof j === "object" ? Object.keys(j).join(",") : typeof j),
        String(typeof j === "string" ? j : JSON.stringify(j) || "").slice(0, 400),
      ],
    };
  }

  const reader = res.body.getReader
    ? res.body.getReader()
    : null;

  if (!reader) {
    // 退化 1：body 可能是异步迭代器
    if (res.body && typeof res.body[Symbol.asyncIterator] === "function") {
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          const s = typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
          for (const line of String(s).split("\n")) {
            const t = line.trim();
            if (!t) continue;
            const ev = tryJson(t);
            if (!ev) continue;
            note(ev);
            applyEvent(ev, text, toolCalls, (u) => { usage = u; }, (e) => { error = e; }, reasoning);
          }
        }
        if (text.length || Object.keys(seen).length) {
          return { text: text.join(""), toolCalls, usage, error, seen, samples };
        }
      } catch { /* 落到下面的退化 */ }
    }

    // 退化 2：整体读文本再逐行解析
    const raw = typeof res.text === "function" ? await res.text() : "";
    const r2 = parseNdjson(raw);
    return { ...r2, seen: { "(整体文本)": 1 }, samples: [String(raw).slice(0, 400)] };
  }

  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = tryJson(line);
      if (!ev) continue;
      note(ev);
      applyEvent(ev, text, toolCalls, (u) => { usage = u; }, (e) => { error = e; }, reasoning);
    }
  }
  if (buf.trim()) {
    const ev = tryJson(buf.trim());
    if (ev) {
      note(ev);
      applyEvent(ev, text, toolCalls, (u) => { usage = u; }, (e) => { error = e; }, reasoning);
    }
  }

  return { text: text.join(""), reasoning: reasoning.join(""), toolCalls, usage, error, seen, samples };
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function applyEvent(ev, text, toolCalls, setUsage, setError, reasoning) {
  if (!ev || typeof ev !== "object") return;
  const t = String(ev.type || "");

  // 正文
  // 实测 2026-10-20（magpie-gateway）：推理模型会先发大量 reasoning-delta，
  // 正文才是 text-delta。只认 text-delta 会把 111 条思考全丢掉。
  if (t === "text-delta" || t === "text" || t === "content-delta" || t === "output-delta") {
    text.push(String(ev.delta ?? ev.text ?? ev.content ?? ""));
    return;
  }

  // 推理过程（不混进正文，单独记，排障时能看到）
  if (t === "reasoning-delta" || t === "reasoning" || t === "thinking-delta") {
    const d = String(ev.delta ?? ev.text ?? ev.content ?? "");
    if (reasoning) reasoning.push(d);
    return;
  }

  // 工具调用
  if (t === "tool-call" || t === "tool-call-done" || t === "tool-use") {
    toolCalls.push({
      id: ev.id || ev.toolCallId || "",
      name: ev.name || ev.toolName || "",
      arguments: ev.arguments || ev.input || ev.args || {},
    });
    return;
  }

  // 结束
  if (t === "done" || t === "finish" || t === "message-stop" || t === "end") {
    if (ev.usage) setUsage(ev.usage);
    // 有些实现把最终文本放在 done 里
    if (!text.length && typeof (ev.text) === "string" && ev.text) text.push(ev.text);
    return;
  }

  // 错误
  if (t === "error") {
    setError({ code: ev.code, message: ev.message || ev.error || String(ev) });
    return;
  }
}

function parseNdjson(raw) {
  const text = [];
  const toolCalls = [];
  let usage = null;
  let error = null;
  for (const line of String(raw).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const ev = tryJson(t);
    if (ev) applyEvent(ev, text, toolCalls, (u) => { usage = u; }, (e) => { error = e; });
  }
  return { text: text.join(""), toolCalls, usage, error };
}

/**
 * 挑一个可用的模型。
 * 优先用选中 agent 自己的；拿不到就取宿主目录里 isCurrent 的。
 */
export async function pickModel(sdk, dataDir, override) {
  // 0. 显式指定（最高优先）
  if (override && override.provider && override.model) {
    return { ok: true, provider: String(override.provider), model: String(override.model), from: "explicit" };
  }

  // 1. App 配置里手选的（bili_set model）
  // 注意：以前这里是 catch {} 完全静默，结果 path/fs 没 import 时报
  // ReferenceError 被吞掉，表现为「配置明明写了却读不到」。
  // 现在失败会带上原因，不隐藏。
  try {
    const cfgPath = path.join(dataDir, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && cfg.modelProvider && cfg.modelId) {
      return { ok: true, provider: String(cfg.modelProvider), model: String(cfg.modelId), from: "config" };
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      // 文件存在但读/解析失败 —— 这是真问题，得看见
      return {
        ok: false,
        error: "读 config.json 里的模型配置失败：" + String(e && e.message ? e.message : e),
        from: "config-error",
      };
    }
    // ENOENT：没写过配置，正常，继续往下走
  }

  const sel = readSelection(dataDir);

  // 2. 选中 agent 的模型配置
  if (sel.agentId) {
    try {
      const m = await agentModel(sdk, sel.agentId);
      if (m && m.provider && m.model) {
        return { ok: true, provider: m.provider, model: m.model, from: "agent" };
      }
    } catch { /* 继续 */ }
  }

  // 3. 宿主目录里「当前」模型
  // 实测 2026-10-20：26 个模型的 isCurrent 全是 false。
  // 以前这里写的是 find(isCurrent) || models[0]，会盲选到第一个
  // （deepseek-flash），而那个 provider 的凭据未必有效，
  // 表现就是笼统的 APP_MODEL_PROVIDER_ERROR。
  // 现在：绝不盲选。没有当前模型就明确报错，让人去选。
  try {
    const list = sdk?.models?.list;
    if (typeof list === "function") {
      const r = await list.call(sdk.models);
      const models = r?.models || [];
      const cur = models.find((x) => x.isCurrent);
      if (cur) {
        return {
          ok: true,
          provider: String(cur.provider || ""),
          model: String(cur.id || cur.model || ""),
          from: "host-current",
        };
      }
      return {
        ok: false,
        error: "宿主没有「当前模型」（" + models.length + " 个候选里 isCurrent 全为 false）。请用 bili_set 选一个，或在设置页选。",
        candidates: models.map((x) => ({ provider: x.provider, id: x.id })),
      };
    }
  } catch { /* 落到失败 */ }

  return { ok: false, error: "拿不到可用模型（agent 没配 或 宿主目录为空）" };
}

/**
 * 纯文本问答（无工具）。用于验证链路。
 * @returns {{ok:boolean, text?:string, usage?:object, error?:string, model?:object}}
 */
/**
 * 推理模型的输出预算是「思考 + 正文」共享的。
 * 实测 2026-10-20：group/auto-hy3 用 200 token 时，
 * 全部烧在 reasoning 上（reasoning:200 output:200），正文一个字都没出来。
 *
 * 所以：如果模型有 reasoning 能力，给一个下限；否则按原样。
 */
export function budgetFor(modelInfo, want) {
  const n = Number(want) || 800;
  const isReasoning = Boolean(modelInfo && modelInfo.reasoning);
  if (!isReasoning) return n;

  // 2026-10-21 实测：group/auto-hy3 一次醒了思考 13319 字（约 8000+ token），
  // 而当时给的 maxTokens 是 4000 —— 正文一个字都没轮到。
  // 下限 2000 太保守了：推理模型的思考量可以到正文的几倍。
  //
  // 新策略：拿模型自己的 maxTokens 能力当上限，但不抢到底：
  //   · 有 contextWindow/maxTokens 信息 → 取 min(模型上限, 16000)，至少 8000
  //   · 没信息 → 保守给 8000
  // 2026-10-22（P2-1）：硬顶提到 32000，给推理模型加倍重试留空间。
  const BUDGET_HARD = 32000;
  const modelCap = Number(modelInfo?.maxTokens) || 0;
  const base = 8000;
  const ceiling = modelCap > 0 ? Math.min(modelCap, BUDGET_HARD) : BUDGET_HARD;
  return Math.max(n, Math.min(ceiling, base));
}

/** 从宿主目录里查某个模型的能力（找不到就当作非推理） */
async function modelInfoOf(sdk, provider, modelId) {
  try {
    const list = sdk?.models?.list;
    if (typeof list !== "function") return null;
    const r = await list.call(sdk.models);
    const arr = r?.models || [];
    return arr.find((x) => x.id === modelId && x.provider === provider) || null;
  } catch {
    return null;
  }
}

export async function ask(sdk, dataDir, { prompt, systemPrompt, maxTokens = 800, temperature = 0.7, override } = {}) {
  const stream = sdk?.models?.stream;
  if (typeof stream !== "function") return { ok: false, error: "宿主未提供 models.stream" };

  const m = await pickModel(sdk, dataDir, override);
  if (!m.ok) return { ok: false, error: m.error };

  const sys = systemPrompt !== undefined ? systemPrompt : (await resolvePersona(sdk, dataDir, (readSelection(dataDir) || {}).agentId || "")).persona;
  const requestId = `ophelia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 推理模型要给足预算，否则全被思考吃掉
  const info = await modelInfoOf(sdk, m.provider, m.model);
  const realMax = budgetFor(info, maxTokens);

  try {
    const res = await stream.call(sdk.models, {
      requestId,
      provider: m.provider,
      model: m.model,
      systemPrompt: sys,
      messages: [{ role: "user", content: String(prompt || "") }],
      maxTokens: realMax,
      temperature,
    });
    const r = await consumeStream(res);
    if (r.error) {
      return {
        ok: false,
        error: `${r.error.code}: ${r.error.message}｜model=${m.model} sys=${String(sys || "").length} maxTokens=${maxTokens}`,
        streamError: r.error,
        model: m,
      };
    }
    return {
      ok: true,
      text: r.text,
      usage: r.usage,
      model: m,
      requestId,
      // 排障：如果 text 为空，看这两个就知道对面发了什么
      seen: r.seen || null,
      samples: r.samples || null,
    };
  } catch (e) {
    // 报错要带上下文，否则只有一个笼统的 PROVIDER_ERROR，什么也看不出来
    const detail = {
      message: String(e && e.message ? e.message : e),
      code: e && (e.code || e.name),
      status: e && (e.status || e.statusCode),
      model: m && m.model,
      provider: m && m.provider,
      sysLen: String(sys || "").length,
      promptLen: String(prompt || "").length,
      maxTokens,
    };
    return {
      ok: false,
      error: `${detail.message}｜model=${detail.model} sys=${detail.sysLen} prompt=${detail.promptLen} maxTokens=${detail.maxTokens} status=${detail.status || "-"} code=${detail.code || "-"}`,
      detail,
      model: m,
    };
  }
}

/**
 * 带工具循环的思考。
 *
 * @param {object} opts
 *   prompt        用户侧的一句话
 *   tools         工具声明 [{name, description, parameters}]
 *   runTool       async (name, args) => { content | string, isError? }
 *   systemPrompt  覆盖默认人格
 *   maxRounds     工具循环上限
 */
export async function think(sdk, dataDir, { prompt, tools = [], runTool, systemPrompt, maxRounds = MAX_TOOL_ROUNDS, maxTokens = 1200, temperature = 0.7, log } = {}) {
  const stream = sdk?.models?.stream;
  if (typeof stream !== "function") return { ok: false, error: "宿主未提供 models.stream" };
  if (typeof runTool !== "function") return { ok: false, error: "缺 runTool" };

  const m = await pickModel(sdk, dataDir);
  if (!m.ok) return { ok: false, error: m.error };

  const sys = systemPrompt !== undefined ? systemPrompt : (await resolvePersona(sdk, dataDir, (readSelection(dataDir) || {}).agentId || "")).persona;
  const messages = [{ role: "user", content: String(prompt || "") }];

  // 推理模型要给足预算（实测：200 token 全被 reasoning 吃掉，正文为空）
  const info = await modelInfoOf(sdk, m.provider, m.model);
  // 2026-10-22（P2-1）：let 以便推理吃空预算时翻倍重试；retriedOnce 限制只重试一次。
  let realMax = budgetFor(info, maxTokens);
  let retriedOnce = false;
  const trace = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const requestId = `ophelia-${Date.now()}-${round}-${Math.random().toString(36).slice(2, 6)}`;
    let res;
    try {
      res = await stream.call(sdk.models, {
        requestId,
        provider: m.provider,
        model: m.model,
        systemPrompt: sys,
        messages,
        tools: tools.length ? tools : undefined,
        maxTokens: realMax,
        temperature,
      });
    } catch (e) {
      // 报错时带上关键上下文，否则只有一个笼统的 PROVIDER_ERROR
      const detail = {
        message: String(e && e.message ? e.message : e),
        code: e && (e.code || e.name),
        status: e && (e.status || e.statusCode),
        model: m && m.model,
        provider: m && m.provider,
        sysLen: String(sys || "").length,
        msgLen: JSON.stringify(messages).length,
        tools: tools.length,
        round: round + 1,
      };
      return { ok: false, error: `${detail.message}｜model=${detail.model} sys=${detail.sysLen} msgs=${detail.msgLen} tools=${detail.tools} round=${detail.round} status=${detail.status || "-"}`, detail, trace, model: m };
    }

    const r = await consumeStream(res);
    if (r.error) {
      return {
        ok: false,
        error: `${r.error.code}: ${r.error.message}｜model=${m.model} sys=${String(sys || "").length} round=${round + 1} maxTokens=${realMax}`,
        streamError: r.error,
        trace,
        model: m,
      };
    }

    // 推理吃空了预算：有 reasoning 但没正文、也没工具调用
    // 实测 2026-10-20：group/auto-hy3 在 200 token 时 reasoning=200 output=200，
    // text 为空、toolCalls 为空 —— 表现就是「跑了但什么都没干」。
    if (!r.text && !r.toolCalls.length && r.reasoning) {
      // 2026-10-22（P2-1）：推理吃空预算时，若 budget 未达硬顶且未重试过，
      //   翻倍重试一次（同一 round 重新请求），给推理模型「多思考出正文」的机会。
      if (!retriedOnce && realMax < 32000) {
        retriedOnce = true;
        realMax = Math.min(realMax * 2, 32000);
        try { log?.warn?.(`[brain] 推理吃空预算（reasoning ${String(r.reasoning).length} 字），翻倍到 ${realMax} 重试`); } catch { /* 忽略 */ }
        continue;
      }
      return {
        ok: false,
        error: `推理吃空了预算（reasoning ${String(r.reasoning).length} 字，正文 0；maxTokens=${realMax}）。这个模型是推理型，需要更大预算。`,
        reasoning: r.reasoning,
        usage: r.usage,
        trace,
        model: m,
      };
    }

    // 没有工具调用 → 这就是最终回答
    if (!r.toolCalls.length) {
      return {
        ok: true, text: r.text, rounds: round + 1, trace, usage: r.usage, model: m,
        toolCalls: trace.length,
        // 带出 reasoning，排障时能看它想了什么
        reasoning: r.reasoning || "",
      };
    }

    // 把 assistant 的工具调用记进消息
    messages.push({
      role: "assistant",
      content: r.toolCalls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments })),
    });

    // 执行每个工具
    for (const call of r.toolCalls) {
      let out;
      try {
        out = await runTool(call.name, call.arguments || {});
      } catch (e) {
        out = { content: `工具执行失败：${e && e.message ? e.message : e}`, isError: true };
      }
      const content = typeof out === "string" ? out : (out?.content ?? "");
      const isError = typeof out === "object" && out?.isError === true;
      trace.push({ round: round + 1, tool: call.name, args: call.arguments, result: String(content).slice(0, 200), isError });
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: String(content) }],
        isError,
      });
    }
  }

  return { ok: false, error: `工具循环超过 ${maxRounds} 轮，主动停手`, trace, model: m };
}
