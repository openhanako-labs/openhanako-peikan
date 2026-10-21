/**
 * verify/wake-order-check.mjs — 醒来的顺序与日记归属
 *
 * 由来（2026-10-20）：
 *   1. 他在私信/评论里回了她，她直接看视频并分享了，一句没回。
 *      prompt 里「先看收件箱」只是建议，靠不住 → 做成代码门：有未回就不分享。
 *   2. 日记是程序拼的模板字符串（时间戳 + 数字），每节长得一样。
 *      那不是日记，是日志。改成她自己写。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const store = await import(pathToFileURL(path.join(APP, "lib/store.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "wakeorder-"));

console.log("[1] 分享前必须处理未回消息");

t("wakeOnce 里有 pendingCount 门", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  assert.ok(src.includes("pendingCount"), "没有未回消息计数");
  assert.ok(src.includes("blockedByPending"), "没有拦截标记");
});

t("有未回时明确不分享", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf("if (pendingCount > 0)");
  assert.ok(i > 0, "找不到拦截分支");
  const block = src.slice(i, i + 400);
  assert.ok(block.includes("sent: false"), "拦截分支应该不发送");
  assert.ok(block.includes("没回"), "理由要说清楚");
});

t("收件箱检查在分享之前", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const p = src.indexOf("imbox.unreplied");
  const s = src.indexOf("share.shareFromRound");
  assert.ok(p > 0 && s > 0, "两处都要在");
  assert.ok(p < s, "先查收件箱，再谈分享");
});

t("prompt 里收件箱是必做，不是建议", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf("const prompt = [");
  const block = src.slice(i, i + 1200);
  assert.ok(block.includes("必须做"), "没说必须");
  assert.ok(block.includes("bili_inbox"), "没提 bili_inbox");
  // 「建议流程」「不必严格照做」这类软化措辞不该出现在收件箱那步
  assert.ok(!/建议流程[\s\S]{0,80}bili_inbox/.test(block), "收件箱被写成了建议");
});

console.log("\n[2] 日记由她自己写");

t("有 bili_diary 工具声明", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  assert.ok(src.includes('name: "bili_diary"'), "工具没声明");
});

t("有 bili_diary 的执行分支", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  assert.ok(src.includes('if (name === "bili_diary")'), "执行器没接");
});

/** 去掉行注释后剩下的代码 */
function codeOnly(src) {
  return src
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      // 简单的：行首是 // 就当注释；行中带 // 的保守保留（可能是 URL）
      return l.trimStart().startsWith("//") ? "" : l;
    })
    .join("\n");
}

t("brain 循环不再自动拼日记", () => {
  const src = codeOnly(fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8"));
  // 旧代码里有「醒了一趟，写了」这句模板
  assert.ok(!src.includes("醒了一趟，写了"), "还在自动拼日记");
});

t("browse 不再代写「我觉得你会想看的」", () => {
  const src = codeOnly(fs.readFileSync(path.join(APP, "lib/browse.js"), "utf8"));
  assert.ok(!src.includes("我觉得你会想看的"), "代码还在替她承诺");
});

t("规则路径的日记标明是自动记录", () => {
  const src = fs.readFileSync(path.join(APP, "lib/browse.js"), "utf8");
  assert.ok(src.includes("规则模式自动记录"), "没区分自动记录与她的日记");
});

console.log("\n[3] appendDiary 支持她自己的标题");

await ta("标题会拼进小节头", async () => {
  const d = mkDir();
  store.appendDiary(d, "executive", "正文内容", "今天想说的");
  const raw = fs.readFileSync(path.join(d, "diary-executive.md"), "utf8");
  assert.ok(raw.includes("今天想说的"), "标题没写进去");
  assert.ok(raw.includes("正文内容"), "正文没写进去");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("不给标题时用时间戳", async () => {
  const d = mkDir();
  store.appendDiary(d, "private", "只有正文");
  const raw = fs.readFileSync(path.join(d, "diary-private.md"), "utf8");
  assert.ok(/##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw), "时间戳格式不对");
  assert.ok(!raw.includes("T"), "不该是 ISO 格式");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("两本日记互不串", async () => {
  const d = mkDir();
  store.appendDiary(d, "executive", "给他的");
  store.appendDiary(d, "private", "给自己的");
  const ex = fs.readFileSync(path.join(d, "diary-executive.md"), "utf8");
  const pv = fs.readFileSync(path.join(d, "diary-private.md"), "utf8");
  assert.ok(ex.includes("给他的") && !ex.includes("给自己的"));
  assert.ok(pv.includes("给自己的") && !pv.includes("给他的"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 她真的能碰到那五个");

const HAND_TOOLS = ["bili_like", "bili_retract", "bili_share", "bili_follow", "bili_edit_dynamic"];

for (const nm of HAND_TOOLS) {
  t(`${nm} 在 TOOLS 声明里`, () => {
    const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
    const i = src.indexOf("const TOOLS = [");
    const j = src.indexOf("];", i);
    const block = src.slice(i, j);
    assert.ok(block.includes(`name: "${nm}"`), `${nm} 没进 TOOLS`);
  });

  t(`${nm} 有执行分支`, () => {
    const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
    assert.ok(src.includes(`if (name === "${nm}")`), `${nm} 没有执行器`);
  });
}

t("写操作要过 publishLive / 开关", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  for (const nm of ["bili_like", "bili_retract", "bili_follow", "bili_edit_dynamic"]) {
    const i = src.indexOf(`if (name === "${nm}")`);
    const block = src.slice(i, i + 900);
    assert.ok(block.includes("publishLive") || block.includes("socialEnabled"), `${nm} 没检查开关`);
  }
});

t("share 检查 shareToOwner", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('if (name === "bili_share")');
  const block = src.slice(i, i + 900);
  assert.ok(block.includes("shareToOwner"), "share 没检查总开关");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
