/**
 * verify/schedule-dedup-check.mjs — 排程不能重复
 *
 * 由来（2026-10-20 22:00）：
 *   digest.daily 在 22:00 跑了**四次**。
 *   因为每次重载 App 都会 schedule 一条，今天重载了四次。
 *   我第一版"修"只加了「有就不排」——但已经排进去的旧条目没清，照样跑四遍。
 *
 * 正确的做法：先 clearHandlerSchedules，再 schedule 一条。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const SRC = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

console.log("[1] 每个会排程的 handler 都必须先清旧的");

const HANDLERS = [
  ["KEYS.digest", "每日摘要"],
  ["KEYS.inbox", "收件箱轮询"],
  ["KEYS.health", "健康心跳"],
];

for (const [key, label] of HANDLERS) {
  t(`${label}（${key}）先清后建`, () => {
    const clearAt = SRC.indexOf(`clearHandlerSchedules(sdk, logger, ${key})`);
    const schedAt = SRC.indexOf(`handlerKey: ${key}`);
    assert.ok(clearAt > 0, `${label} 没有 clearHandlerSchedules`);
    assert.ok(schedAt > 0, `${label} 没有 schedule`);
    assert.ok(clearAt < schedAt, `${label} 的顺序反了：先 schedule 再 clear 等于没清`);
  });
}

console.log("\n[2] 「有就不排」这种写法不够");

t("digest 不该靠 hasXxx 判断取舍（旧条目不会被清）", () => {
  // 允许保留 hasXxx 作为日志，但不能只靠它
  const i = SRC.indexOf("existingDigest");
  assert.equal(i, -1, "existingDigest 还在 —— 这个写法只防新增，不防已有重复");
});

t("health 不该靠 hasHealth 判断取舍", () => {
  // 注释里提到「以前靠 hasHealth」是允许的；要查的是代码里还有没有用它
  const code = SRC.split("\n").map((l) => (l.trimStart().startsWith("//") ? "" : l)).join("\n");
  const i = code.indexOf("hasHealth");
  assert.equal(i, -1, "hasHealth 还在代码里 —— 同上");
});

console.log("\n[3] 清理函数本身对");

t("clearHandlerSchedules 按 handlerKey 全清", () => {
  const i = SRC.indexOf("async function clearHandlerSchedules");
  assert.ok(i > 0, "找不到这个函数");
  const block = SRC.slice(i, i + 600);
  assert.ok(block.includes("s.handlerKey !== key"), "没按 handlerKey 比对");
  assert.ok(block.includes("unschedule"), "没有真的注销");
  assert.ok(block.includes("continue"), "没有跳过不匹配的");
});

t("wake 的排程自己去重（scheduleNext 里先清）", () => {
  const i = SRC.indexOf("async function scheduleNext");
  assert.ok(i > 0, "找不到 scheduleNext");
  const block = SRC.slice(i, i + 800);
  assert.ok(block.includes("clearRhythmSchedules"), "scheduleNext 没先清 rhythm 排程");
});

console.log("\n[4] 22:00 那个事故不该重演");

t("digest 的排程点带「旧排程已清」标记", () => {
  assert.ok(
    SRC.includes("旧的已清") || SRC.includes("旧排程已清"),
    "日志里看不出这次是否清过——下次排重复了还是查不出来"
  );
});

t("inbox 的启动日志标明清过旧排程", () => {
  const i = SRC.indexOf("[inbox.tick] 收件箱监听已启动");
  assert.ok(i > 0);
  const line = SRC.slice(i, i + 160);
  assert.ok(line.includes("旧排程已清"), "inbox 日志没标明");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
