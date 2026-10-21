/**
 * lib/taste.js — 她的口味（P20）
 *
 * 这个模块回答一个问题：**她凭什么觉得一条内容值得看？**
 *
 * 三个来源，权重不同：
 *   ① **她自己的判断**（她看过之后写的感受）—— 最重
 *   ② **主人的反馈**（他说什么、赞什么、不理什么）—— 影响因子，不是命令
 *   ③ 初始配置（config.json 里那份手写清单）—— 起点，会被慢慢覆盖
 *
 * 设计立场（2026-10-20 主人明确）：
 *   **她也可以有自己的喜好，不必完全按主人的想法。**
 *   所以 owner 的信号是「一个很强的参考」，不是「必须服从」。
 *   如果两者冲突，她保留自己的判断，但会记录这个分歧。
 *
 * 存哪：<dataDir>/taste.json
 *   {
 *     "traits": { "时政": { mine: -0.4, owner: -0.8, n: 3 } },
 *     "divergences": [ ... ],   // 她和主人判断不一致的记录
 *     "updatedAt": "..."
 *   }
 */

import fs from "node:fs";
import path from "node:path";

const FILE = "taste.json";

/** 一次调整的步长：小步走，避免一句话把口味带偏 */
const STEP = 0.15;
/** 上下限 */
const CLAMP = 1.0;

function read(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8"));
    return {
      traits: j?.traits && typeof j.traits === "object" ? j.traits : {},
      divergences: Array.isArray(j?.divergences) ? j.divergences : [],
      updatedAt: j?.updatedAt || null,
    };
  } catch {
    return { traits: {}, divergences: [], updatedAt: null };
  }
}

function write(dataDir, st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, FILE),
      JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2) + "\n",
    );
  } catch { /* 写失败不影响主流程 */ }
}

const clamp = (v) => Math.max(-CLAMP, Math.min(CLAMP, v));
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 记一次接触。
 *
 * @param {string} trait  主题词（如「时政」「凶案」「猫咪」）
 * @param {object} opts
 *   side   "mine" | "owner"   谁的态度
 *   delta  +1 喜欢 / -1 不喜欢   （会乘 STEP）
 *   note   一句说明（存进分歧记录）
 */
export function touch(dataDir, trait, { side = "mine", delta = 0, note = "" } = {}) {
  const key = String(trait || "").trim();
  if (!key) return { ok: false, error: "缺主题词" };
  if (side !== "mine" && side !== "owner") return { ok: false, error: "side 只能是 mine / owner" };

  const st = read(dataDir);
  const cur = st.traits[key] || { mine: 0, owner: 0, n: 0 };
  const d = Number(delta) || 0;

  cur[side] = round2(clamp(Number(cur[side] || 0) + d * STEP));
  cur.n = Number(cur.n || 0) + 1;
  st.traits[key] = cur;

  // 两边都表态过、且方向相反 → 记一笔分歧
  if (cur.mine !== 0 && cur.owner !== 0 && Math.sign(cur.mine) !== Math.sign(cur.owner)) {
    st.divergences.push({
      at: new Date().toISOString(),
      trait: key,
      mine: cur.mine,
      owner: cur.owner,
      note: String(note || "").slice(0, 160),
    });
    st.divergences = st.divergences.slice(-50);
  }

  write(dataDir, st);
  return { ok: true, trait: key, now: cur };
}

/**
 * 主题词 → 字面线索（同义词/关联词）。
 *
 * 为什么需要（2026-10-20 实测）：taste.json 里存的是「凶案」这种抽象标签，
 * 但她的笔记里写的是「一整排人替一个被杀死的婴儿论证死了是解脱」——
 * **通篇没有「凶案」两个字**，字面匹配永远命不中。
 *
 * 所以每个主题词要带一组能代表它的字面线索。
 * 只收录相对确定的；宁可漏掉，不要误伤（误伤会把无关内容也过滤掉）。
 */
export const TRAIT_CUES = {
  "凶案": ["被杀", "杀死", "凶手", "命案", "遗体", "尸", "惨死", "遇害", "谋杀", "刑案", "灭门", "婴儿"],
  "时政": ["时政", "体制", "政策", "政府", "养老", "社保", "信访", "官场", "选举"],
  "社会新闻": ["社会新闻", "事件", "通报", "警方", "起诉", "维权"],
  "鬼畜": ["鬼畜", "二创", "魔改", "音MAD", "音MAD", "循环"],
  "猫咪": ["猫", "小猫", "橘猫", "猫咖"],
  "游戏实况": ["游戏", "通关", "实况", "攻略", "MOD", "模组", "副本"],
  "科技评测": ["评测", "参数", "显卡", "跑分", "上手", "开箱"],
  "影视解说": ["解说", "剧情", "导演", "镜头", "结局", "剧集"],
  "猎奇": ["猎奇", "重口", "不适", "头皮发麻"],
  "带货": ["带货", "下单", "链接在", "优惠券", "直播间购买"],
  "星露谷": ["星露谷", "农场", "种地"],
  "AI工具": ["AI", "模型", "提示词", "agent", "智能体"],
};

/** 一个主题词在给定文本里是否命中（先试字面，再试线索） */
function hitsTrait(text, trait) {
  if (!trait) return false;
  if (text.includes(trait)) return true;
  const cues = TRAIT_CUES[trait];
  if (!cues) return false;
  return cues.some((c) => c && text.includes(c));
}

/**
 * 算一条内容的「口味分」。
 *
 * 权重：自己的判断 0.7，主人反馈 0.3。
 * —— 她有自己的一份，但主人的意见仍然算数。
 *
 * @returns {{score:number, hits:Array<{trait:string, w:number, via:string}>}}
 */
export function scoreFor(dataDir, text = "") {
  const st = read(dataDir);
  const t = String(text || "");
  const hits = [];

  for (const [trait, v] of Object.entries(st.traits)) {
    if (!hitsTrait(t, trait)) continue;

    const mine = Number(v.mine || 0);
    const owner = Number(v.owner || 0);

    // 权重分配（2026-10-20 改）：
    //   两边都表过态 → 0.7 / 0.3（她的判断为主）
    //   只有一边有数据 → 那一方占满
    // 为什么：她还没形成判断时，让她那 0.7 空着 = 把主人的声音打了三折，
    // 结果就是「主人说不看」只影响 4.5%，等于没影响。
    let w = 0;
    if (mine !== 0 && owner !== 0) w = mine * 0.7 + owner * 0.3;
    else if (mine !== 0) w = mine;
    else if (owner !== 0) w = owner;

    if (w !== 0) {
      const via = t.includes(trait) ? "literal" : "cue";
      hits.push({ trait, w: round2(w), via });
    }
  }

  // 归一到一个大概 -1..+1 的区间（命中多条不会无限叠加）
  const raw = hits.reduce((s, h) => s + h.w, 0);
  const score = Math.max(-1, Math.min(1, raw / Math.max(1, Math.sqrt(hits.length))));
  return { score: round2(score), hits };
}

/** 她现在的好恶（给 UI / 提示词用） */
export function snapshot(dataDir, { limit = 20 } = {}) {
  const st = read(dataDir);
  const rows = Object.entries(st.traits)
    .map(([trait, v]) => {
      const mine = Number(v.mine || 0);
      const owner = Number(v.owner || 0);
      // 综合态度：跟 scoreFor 用同一套权重规则
      let eff = 0;
      if (mine !== 0 && owner !== 0) eff = mine * 0.7 + owner * 0.3;
      else if (mine !== 0) eff = mine;
      else if (owner !== 0) eff = owner;
      return {
        trait,
        mine: round2(mine),
        owner: round2(owner),
        effective: round2(eff),
        n: Number(v.n || 0),
        conflict: mine !== 0 && owner !== 0 && Math.sign(mine) !== Math.sign(owner),
      };
    })
    .sort((a, b) => Math.abs(b.effective) - Math.abs(a.effective))
    .slice(0, limit);

  return {
    rows,
    divergences: st.divergences.slice(-10).reverse(),
    updatedAt: st.updatedAt,
    counts: { traits: Object.keys(st.traits).length, divergences: st.divergences.length },
  };
}

/**
 * 把口味档案翻译成一段给模型的说明。
 * 让她知道「你喜欢什么、主人不喜欢什么、以及哪些地方你们不一致」。
 */
export function brief(dataDir) {
  const s = snapshot(dataDir, { limit: 12 });
  if (!s.rows.length) return "";

  const lines = ["=== 你的口味（会随经历变） ==="];
  const like = s.rows.filter((r) => r.effective > 0.05).slice(0, 6);
  const dislike = s.rows.filter((r) => r.effective < -0.05).slice(0, 6);

  if (like.length) lines.push("你最近偏爱的：" + like.map((r) => `${r.trait}(${r.effective})`).join("、"));
  if (dislike.length) lines.push("你最近不爱看的：" + dislike.map((r) => `${r.trait}(${r.effective})`).join("、"));

  const conflicts = s.rows.filter((r) => r.conflict);
  if (conflicts.length) {
    lines.push(
      "你和主人在这些地方看法不同（你还留着你的判断）：" +
      conflicts.map((r) => `${r.trait}（你 ${r.mine} / 他 ${r.owner}）`).join("、"),
    );
  }

  return lines.join("\n");
}

export { read as _read, write as _write };
