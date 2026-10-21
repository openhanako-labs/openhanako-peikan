/**
 * verify/ui-coverage-check.mjs — 能力必须有界面入口
 *
 * 由来（2026-10-20）：用户问「还有什么功能缺失」。
 * 查下来发现：53 个工具全做了，其中一大半在界面上 0 处引用 ——
 * 只有 agent 能调，用户点不到。这不是功能缺失，是入口缺失。
 *
 * 这个测试的本质：列出「应当能用的能力」，逐个断言它在 UI 里有入口。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const HTML = fs.readFileSync(path.join(APP, "ui/studio.html"), "utf8");
const JS = fs.readFileSync(path.join(APP, "ui/assets/studio-script.js"), "utf8");
const ROUTES = fs.readFileSync(path.join(APP, "lib/register-routes.js"), "utf8");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

console.log("[1] 页签");

const TABS = [
  ["notes", "笔记本"],
  ["rhythm", "作息"],
  ["inbox", "互动"],
  ["learned", "学到"],
  ["drafts", "草稿箱"],
  ["review", "待拍板"],
  ["diary", "日记"],
  ["ledger", "账本"],
  ["setup", "接入"],
  ["settings", "设置"],
];

for (const [id, label] of TABS) {
  t(`页签「${label}」`, () => {
    assert.ok(HTML.includes(`data-tab="${id}"`), `导航里没有 ${id}`);
    assert.ok(HTML.includes(`data-panel="${id}"`), `面板里没有 ${id}`);
    assert.ok(JS.includes(`${id}:`), `TITLES 里没有 ${id}`);
  });
}

console.log("\n[2] 用户能碰到的能力 → UI 必须有路");

const FEATURES = [
  { name: "评论/私信摘要", ui: ["data-panel=\"inbox\"", "digest-run", "loadDigest"], route: "/digest" },
  { name: "白名单可见", ui: ["allow-list", "loadAllowlist"], route: "/allowlist" },
  { name: "白名单可清空", ui: ["allow-forget"], route: "/allowlist/forget" },
  { name: "口味学习可见", ui: ["taste-kv", "loadTaste"], route: "/taste" },
  { name: "沉默衰减可见", ui: ["silence-kv"], route: "/silence" },
  { name: "点赞记录可见", ui: ["likes-list"], route: "/likes" },
  { name: "她发出去的可见", ui: ["sent-list", "loadSent"], route: "/sent" },
  { name: "能撤回", ui: ["js-retract", "bindRetract"], route: "/retract" },
];

for (const f of FEATURES) {
  t(f.name, () => {
    for (const token of f.ui) {
      assert.ok(HTML.includes(token) || JS.includes(token), `UI 缺 ${token}`);
    }
    assert.ok(ROUTES.includes(`"${f.route}"`), `路由缺 ${f.route}`);
  });
}

console.log("\n[3] 危险动作必须有确认");

t("撤回是两段式（预演 → 真删）", () => {
  const i = JS.indexOf("function bindRetract");
  assert.ok(i > 0, "找不到 bindRetract");
  const block = JS.slice(i, i + 2000);
  // 要么有 confirm，要么是首次点预演（这里用 payload.live）
  assert.ok(block.includes("live = true") || block.includes("confirm(") || block.includes("预演"), "撤回没有确认环节");
});

t("撤回真发要过 publishLive", () => {
  const i = ROUTES.indexOf('"/retract"');
  assert.ok(i > 0, "找不到 retract 路由");
  const block = ROUTES.slice(i, i + 900);
  assert.ok(block.includes("publishLive"), "撤回没检查 publishLive");
});

console.log("\n[4] 新页签不会让老页签坏掉");

t("每个 data-panel 都有对应的 data-tab", () => {
  const panels = [...HTML.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
  const tabs = [...HTML.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  for (const p of panels) {
    assert.ok(tabs.includes(p), `面板 ${p} 没有对应页签`);
  }
});

t("每个 data-tab 都有对应面板", () => {
  const panels = [...HTML.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
  const tabs = [...HTML.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  for (const x of tabs) {
    assert.ok(panels.includes(x), `页签 ${x} 没有对应面板`);
  }
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
