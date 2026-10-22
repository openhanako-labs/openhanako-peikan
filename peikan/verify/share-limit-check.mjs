/**
 * verify/share-limit-check.mjs — 分享上限唯一真相验证（P0，2026-10-22）
 *
 * 由来：分享上限曾有四套数字并存——
 *   config.shareDaily(5) / config.shareMaxPerDay(10) / quota.DEFAULTS.shareDaily(3) / 代码默认 10
 * 结果界面看到的数和实际推送量对不上（日志里出现过「今日已推 3 条（上限 2）」）。
 *
 * 现在：quota.status 是唯一真相。这个检查数「算分享上限的出口」——必须只有 quota 一处在算。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const libDir = path.join(APP, "lib");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const readAll = () => {
  const out = {};
  for (const f of fs.readdirSync(libDir).filter((x) => x.endsWith(".js"))) {
    out[f] = fs.readFileSync(path.join(libDir, f), "utf8");
  }
  return out;
};

console.log("[1] shareMaxPerDay 不再被当上限使用");
t("没有代码从 shareMaxPerDay 取默认上限", () => {
  const src = readAll();
  // 允许出现在 config.js 定义/归一 与注释里；不允许出现在 lib 其他文件的「取值」上下文
  const offenders = [];
  for (const [f, s] of Object.entries(src)) {
    if (f === "config.js") continue;
    // 去掉行注释后再找
    const code = s.split("\n").map((l) => (l.trimStart().startsWith("//") ? "" : l)).join("\n");
    // 允许注释里提到；这里找真正的取值写法 Number(...shareMaxPerDay) / cfg.shareMaxPerDay
    if (/Number\([^)]*shareMaxPerDay/.test(code) || /cfg\.shareMaxPerDay/.test(code) || /c\.shareMaxPerDay/.test(code)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `这些文件还在用 shareMaxPerDay 当上限：${offenders.join(", ")}`);
});

console.log("\n[2] 分享上限只在 quota 算");
t("quota.js 有 shareDaily 上限", () => {
  const s = readAll()["quota.js"];
  assert.ok(s.includes("shareDaily"), "quota 没有 shareDaily");
});
t("share.js 不再自己维护一份独立的配额账", () => {
  const s = readAll()["share.js"];
  // 兼容回退允许保留（opts.cfg.quota.shareDaily），但不能再有第二套 quota 账
  assert.ok(s.includes("quota.record"), "share 应把分享记进 quota");
});

console.log("\n[3] bili_my_day 的剩余量来自 quota");
t("wake.js 的 bili_my_day 用 quota.status", () => {
  const s = readAll()["wake.js"];
  const i = s.indexOf("今天还能递给他");
  assert.ok(i > 0, "找不到 bili_my_day 返回段");
  const block = s.slice(i - 700, i);
  assert.ok(block.includes("quotaMod.status"), "bili_my_day 没从 quota 读剩余量");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
