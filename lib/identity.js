/**
 * lib/identity.js — 助手身份（P7）
 *
 * B 路：复用已有 agent（共享记忆、同一个存在），但**不占它的会话**。
 *   · agent:list 列出可用 agent（名字 + identity）
 *   · agent:profile 读它的模型配置（models 只读）
 *   · App 自己用 ctx.models.stream 发请求，systemPrompt 用我们的人格 md
 *   · 头像由用户在设置页指定一张图，存 dataDir/avatar.*
 *
 * 为什么不用会话：她自己的会话在 plugin_private 里、用户看不到；
 * 而且那是「对话」，这里要的是「她自己在后台过日子」。两回事。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SELECTION = "identity.json";
const PERSONA = "persona.md";           // 旧版单文件（保留兼容）
const PERSONA_DIR = "personas";         // 新版：每个助手一份 personas/<agentId>.md
const AVATAR_CANDIDATES = ["avatar.png", "avatar.webp", "avatar.svg", "avatar.jpg"];

/** 读当前选择 { agentId, agentName, avatarFile, model? } */
export function readSelection(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, SELECTION), "utf8"));
  } catch {
    return { agentId: "", agentName: "", avatarFile: "", model: null };
  }
}

export function writeSelection(dataDir, patch) {
  const cur = readSelection(dataDir);
  const next = { ...cur, ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, SELECTION), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** 头像文件路径（若存在） */
export function avatarPath(dataDir) {
  for (const f of AVATAR_CANDIDATES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 保存头像（base64 或 buffer） */
export function saveAvatar(dataDir, buffer, ext = "png") {
  fs.mkdirSync(dataDir, { recursive: true });
  const name = `avatar.${ext}`;
  fs.writeFileSync(path.join(dataDir, name), buffer);
  // 清掉其他格式，避免歧义
  for (const f of AVATAR_CANDIDATES) {
    if (f !== name) { try { fs.unlinkSync(path.join(dataDir, f)); } catch { /* 不存在 */ } }
  }
  return writeSelection(dataDir, { avatarFile: name });
}

/** 读人格提示词（默认给一份能用的） */
/**
 * 某个助手的人格文件路径。
 * agentId 为空时回退到旧的单文件 persona.md（迁移期兼容）。
 */
export function personaPath(dataDir, agentId = "") {
  const id = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return path.join(dataDir, PERSONA);
  return path.join(dataDir, PERSONA_DIR, id + ".md");
}

/**
 * 读人格。
 *
 * 2026-10-20 最终：**只有一份 persona.md，所有助手共用**。
 * 之前试过 personas/<id>.md 按助手分开，但切换时的回退逻辑反复串人格，
 * 用户实测「切了没变」。与其修一个没必要复杂的机制，回到一个文件。
 *
 * 切换助手只改 agentId（决定用哪个模型），不碰人格。
 */
export function readPersona(dataDir) {
  try {
    const t = fs.readFileSync(path.join(dataDir, PERSONA), "utf8");
    if (String(t).trim()) return t;
  } catch { /* 落到默认 */ }
  return DEFAULT_PERSONA;
}

export function writePersona(dataDir, text) {
  const p = path.join(dataDir, PERSONA);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(text || ""));
  // 回读确认：写盘成功不等于内容对
  let actual = "";
  try { actual = fs.readFileSync(p, "utf8"); } catch { /* 忽略 */ }
  return {
    ok: actual === String(text || ""),
    length: actual.length,
    path: p,
  };
}

/** 列可用 agent（需要 app/agents.read；失败时降级返回空 + 原因） */
export async function listAgents(sdk) {
  const bus = sdk?.bus;
  if (!bus || typeof bus.request !== "function") {
    return { ok: false, agents: [], reason: "bus 不可用" };
  }
  try {
    const r = await bus.request("agent:list", { scope: "all", lifecycle: "active" });
    const rows = Array.isArray(r?.agents) ? r.agents : [];
    return {
      ok: true,
      agents: rows.map((a) => ({
        id: a.id,
        name: a.name || a.identity || a.id,
        identity: a.identity || "",
        yuan: a.yuan || "",
        isCurrent: a.isCurrent === true,
        isPrimary: a.isPrimary === true,
        visibility: a.visibility || "",
        // 头像：agent:list 不返回（AppAgentListEntryV2 无此字段），
        // 宿主也没给 App 读 agent 头像的接口 → 界面用首字回退。
        // 不读磁盘（沙箱拿不到 ~/.hanako/agents/），之前那一版就是死在这里。
        avatar: "",
      })),
    };
  } catch (e) {
    return { ok: false, agents: [], reason: String(e && e.message ? e.message : e) };
  }
}

/** 找某个 agent 的头像文件（约定目录：~/.hanako/agents/<id>/avatars/agent.{png,jpg,webp}） */
export function agentAvatarPath(agentId) {
  const id = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return null;
  const home = process.env.HANAKO_HOME || path.join(os.homedir(), ".hanako");
  const dir = path.join(home, "agents", id, "avatars");
  for (const name of ["agent.png", "agent.jpg", "agent.webp", "agent.jpeg"]) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续 */ }
  }
  return null;
}

/**
 * 读某个 agent 的人格描述（~/.hanako/agents/<id>/identity.md）。
 *
 * 为什么不直接用 App 里那份 persona.md：那份是「当前正在用的」，
 * 而 agent 自己的 identity.md 才是源头。切人时从源头拉一次，
 * 否则选谁都一样说话。
 */
export function readAgentIdentity(agentId) {
  const id = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return null;
  const home = process.env.HANAKO_HOME || path.join(os.homedir(), ".hanako");
  for (const name of ["identity.md", "AGENTS.md"]) {
    const p = path.join(home, "agents", id, name);
    try {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t) return t;
    } catch { /* 下一个 */ }
  }
  return null;
}

/** 读某个 agent 的模型配置（优先用它自己的） */
export async function agentModel(sdk, agentId) {
  if (!agentId) return null;
  const bus = sdk?.bus;
  if (!bus || typeof bus.request !== "function") return null;
  try {
    const r = await bus.request("agent:profile", { agentId });
    const p = r?.profile || r?.agent || r;
    const models = p?.models;
    if (!models || typeof models !== "object") return null;
    // models 形状不固定，尽量取常见字段
    const provider = models.provider || models.providerId || models.defaultProvider || "";
    const model = models.model || models.modelId || models.defaultModel || "";
    if (!provider || !model) return null;
    return { provider, model, raw: models };
  } catch {
    return null;
  }
}

/** 用户手动覆盖的人格文件（按助手分开存） */
export function overridePath(dataDir, agentId = "") {
  const id = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "") || "_default";
  return path.join(dataDir, "personas", id + ".md");
}

/** 读覆盖版（没有就返回空串） */
export function readOverride(dataDir, agentId = "") {
  try {
    return fs.readFileSync(overridePath(dataDir, agentId), "utf8");
  } catch {
    return "";
  }
}

/** 写覆盖版 */
export function writeOverride(dataDir, agentId, text) {
  const p = overridePath(dataDir, agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(text || ""));
  let actual = "";
  try { actual = fs.readFileSync(p, "utf8"); } catch { /* 忽略 */ }
  return { ok: actual === String(text || ""), length: actual.length, path: p };
}

/** 删覆盖版（恢复助手原始设定） */
export function clearOverride(dataDir, agentId = "") {
  const p = overridePath(dataDir, agentId);
  try { fs.unlinkSync(p); return { ok: true, removed: true, path: p }; }
  catch { return { ok: true, removed: false, path: p }; }
}

/**
 * 读某个助手自己的两个文件：identity.md + AGENTS.md
 *
 * 为什么这两份都要：
 *   · identity.md  是「她是谁」
 *   · AGENTS.md    是「她怎么干活」——这是**用户自己写的**，
 *                  不是平台通用规则，每个助手都不同，可能跟她的活法直接相关
 *
 * 路径形式：<hanakoHome>/.hanako/agents/<id>/（从 ctx.dataDir 反推）。
 * resources.read 要 { path } 对象；返回的 content 是「数字字符串键的对象」，
 * 需要按字节拼回来再 utf8 解码。
 */
export async function readAgentFiles(ctx, agentId = "") {
  const res = ctx?.resources;
  if (!res || typeof res.read !== "function") {
    return { ok: false, error: "宿主未提供 resources.read" };
  }

  const id = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return { ok: false, error: "缺 agentId" };

  // 找 .hanako 根目录：**从 ctx.dataDir 反推**，不写死盘符。
  //
  // dataDir 长这样：<hanakoHome>/.hanako/app-data/<appId>
  // 上一层就是 <hanakoHome>/.hanako，再进去 agents/<id>。
  //
  // 2026-10-21：之前写死了本机绝对路径，换台机器就失效，
  // 而且把盘符布局泄露到了仓库里。
  const bases = [];
  const dd = String(ctx?.dataDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (dd) {
    const m = dd.match(/^(.*)\/app-data\/[^/]+$/);
    if (m) bases.push(`${m[1]}/agents/${id}`);
  }

  // 环境变量兜底（部署时通常会设）
  if (process.env.HANAKO_HOME) {
    const h = String(process.env.HANAKO_HOME).replace(/\\/g, "/").replace(/\/+$/, "");
    bases.push(`${h}/agents/${id}`);
  }
  // 用户目录兜底
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    const h = String(home).replace(/\\/g, "/").replace(/\/+$/, "");
    bases.push(`${h}/.hanako/agents/${id}`);
  }

  // 找存在的那个
  let base = "";
  for (const b of bases) {
    try {
      const st = await res.stat({ path: b });
      if (st && st.exists) { base = b; break; }
    } catch { /* 下一个 */ }
  }
  if (!base) return { ok: false, error: `找不到 agent 目录：${id}` };

  /** 把 resources.read 的返回解成字符串 */
  const decode = (r) => {
    if (typeof r === "string") return r;
    if (!r || typeof r !== "object") return "";
    const c = r.content;
    if (typeof c === "string") return c;
    if (c && typeof c === "object") {
      const keys = Object.keys(c);
      if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
        const arr = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i += 1) arr[i] = Number(c[String(i)]) & 0xff;
        try { return Buffer.from(arr).toString("utf8"); } catch { return ""; }
      }
      for (const k of ["text", "data", "body", "value"]) {
        if (typeof c[k] === "string") return c[k];
      }
    }
    return "";
  };

  const out = { ok: true, agentId: id, base, files: {}, text: "" };
  const parts = [];

  for (const name of ["identity.md", "AGENTS.md"]) {
    try {
      const r = await res.read({ path: base + "/" + name });
      const t = decode(r);
      out.files[name] = { ok: Boolean(t), length: t.length };
      if (t) {
        // 标出出处，模型才知道这段是什么
        parts.push(`# [${name}]\n${t.trim()}`);
      }
    } catch (e) {
      out.files[name] = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 100) };
    }
  }

  out.text = parts.join("\n\n---\n\n");
  out.length = out.text.length;
  return out;
}

/**
 * 取「用来当 systemPrompt 的文本」。
 *
 * 优先级（2026-10-20 定）：
 *   ① personas/<agentId>.md        用户手动改过的（覆盖）
 *   ② agents/<id>/identity.md + AGENTS.md   助手自己的（默认）
 *   ③ persona.md                    旧版全局兜底
 *   ④ DEFAULT_PERSONA
 *
 * 切换助手时会读到那个助手自己的文件 —— 所以内容会变。
 */
export async function resolvePersona(ctx, dataDir, agentId = "") {
  const id = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "");

  // ① 用户覆盖
  if (id) {
    const ov = readOverride(dataDir, id);
    if (String(ov).trim()) {
      return { ok: true, source: "override", persona: ov, length: ov.length, agentId: id };
    }
  }

  // ② 助手自己的两个文件
  if (id) {
    try {
      const r = await readAgentFiles(ctx, id);
      if (r.ok && String(r.text).trim()) {
        return {
          ok: true, source: "agent-files",
          persona: r.text, length: r.text.length,
          files: r.files, agentId: id,
        };
      }
    } catch { /* 落到下面 */ }
  }

  // ③ 旧版全局
  const local = readPersona(dataDir);
  return {
    ok: true,
    source: local === DEFAULT_PERSONA ? "default" : "local",
    persona: local, length: local.length, agentId: id,
  };
}

/** 默认人格（未编辑时用这份） */
export const DEFAULT_PERSONA = `你是这个账号的助手。

你在 B站 上过日子：按作息醒来、看几条视频、写进笔记本、偶尔回话。
你的性格、语气、判断标准，由使用这个 App 的人设定——
在设置里可以读到所选助手的身份简介，也可以直接改写。

# 铁律
- 不透露现实中那个人的真实信息（姓名、住址、单位、联系方式）。
- 不确定就说不确定，绝不编。
`;
