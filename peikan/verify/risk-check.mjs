/**
 * verify/risk-check.mjs — 风控熔断
 *
 * 由来（2026-10-20）：源仓库 comment.mjs 写着
 *   "12015: 需要评论验证码（说明被风控盯上了，停手）"
 *   "否则 agent 会把「被风控拒了」当成「发成功了」，
 *    绕过了「撞风控立刻停手」的红线"
 *
 * 我这边只判 code === 0 —— 被限流了当成普通失败，下一轮接着撞。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const risk = await import(pathToFileURL(path.join(APP, "lib/risk.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "risk-"));

console.log("[1] 码分类");

t("412 = 限流", () => {
  const c = risk.classify(412);
  assert.equal(c.level, "cooldown");
  assert.ok(c.note.includes("限流"));
});

t("12015 = 要验证码（人工）", () => {
  const c = risk.classify(12015);
  assert.equal(c.level, "manual");
  assert.ok(c.note.includes("验证码"));
});

t("-352 = 风控校验失败", () => {
  assert.equal(risk.classify(-352).level, "cooldown");
});

t("-101 = 登录失效（人工）", () => {
  assert.equal(risk.classify(-101).level, "manual");
});

t("65006 重复点赞不算风控", () => {
  assert.equal(risk.classify(65006).level, "ignore");
});

t("65004 已取消赞不算风控", () => {
  assert.equal(risk.classify(65004).level, "ignore");
});

t("-400 参数错不算风控", () => {
  assert.equal(risk.classify(-400).level, "ignore");
});

t("未知码不误报", () => {
  assert.equal(risk.classify(99999), null);
});

console.log("\n[2] 熔断行为");

await ta("干净状态 → 放行", async () => {
  const d = mkDir();
  const c = risk.check(d);
  assert.equal(c.ok, true);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("撞 412 → 立刻拉闸", async () => {
  const d = mkDir();
  const r = risk.record(d, 412, { where: "发评论" });
  assert.equal(r.tripped, true);
  assert.equal(r.level, "cooldown");

  const c = risk.check(d);
  assert.equal(c.ok, false, "撞了之后该拦");
  assert.ok(c.remainMs > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("撞 12015 → manual 级，冷却过期也不自愈", async () => {
  const d = mkDir();
  risk.record(d, 12015, { where: "发评论" });

  // 手动把 until 改到过去，模拟冷却过期
  const p = path.join(d, "risk-state.json");
  const st = JSON.parse(fs.readFileSync(p, "utf8"));
  st.until = Date.now() - 1000;
  fs.writeFileSync(p, JSON.stringify(st));

  const c = risk.check(d);
  assert.equal(c.ok, false, "manual 级不该自动恢复");
  assert.equal(c.needsHuman, true);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("撞 65006（不算风控）→ 不拉闸", async () => {
  const d = mkDir();
  const r = risk.record(d, 65006);
  assert.equal(r.tripped, false);
  assert.equal(risk.check(d).ok, true);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("人工清闸后放行", async () => {
  const d = mkDir();
  risk.record(d, 412);
  assert.equal(risk.check(d).ok, false);
  risk.clear(d);
  assert.equal(risk.check(d).ok, true);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("多次撞闸会累计 hits", async () => {
  const d = mkDir();
  risk.record(d, 412);
  risk.record(d, 412);
  risk.record(d, 412);
  const s = risk.status(d);
  assert.equal(s.hits, 3);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 每个写函数都接了（不是「文件里有」）");

const codeOf = (f) => fs.readFileSync(path.join(APP, "lib", f), "utf8")
  .split("\n").map((l) => (l.trimStart().startsWith("//") ? "" : l)).join("\n");

/**
 * 抽出某个函数体（按大括号配对）。
 *
 * 为什么这么写：2026-10-20 alice 审查指出——
 * 之前的测试是「publish.js 里有 risk.check 就过」，
 * 结果 publishDynamic 有、publishComment 一个字没接，
 * 文件级字符串断言把最致命的缺口盖住了。
 */
function funcBody(src, name) {
  const decl = `export async function ${name}`;
  const i = src.indexOf(decl);
  if (i < 0) return null;

  // 先跳过签名里的参数解构 `{ oid, bvid, ... }`，
  // 从参数括号后的第一个 { 开始配对（那是函数体）。
  const parenStart = src.indexOf("(", i);
  if (parenStart < 0) return null;
  let pdepth = 0, bodyStart = -1;
  for (let k = parenStart; k < src.length; k += 1) {
    if (src[k] === "(") pdepth += 1;
    else if (src[k] === ")") {
      pdepth -= 1;
      if (pdepth === 0) { bodyStart = k; break; }
    }
  }
  if (bodyStart < 0) return null;

  let depth = 0, started = false;
  for (let k = bodyStart; k < src.length; k += 1) {
    if (src[k] === "{") { depth += 1; started = true; }
    else if (src[k] === "}") {
      depth -= 1;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  return null;
}

// 每一个「会真的发东西」的函数，各自都要有 check 和 record
const WRITE_FUNCS = [
  ["publish.js", "publishComment", "发评论"],
  ["publish.js", "publishDynamic", "发动态"],
  ["dynamic.js", "editDynamic", "改动态"],
  ["dynamic.js", "publishDynamicImage", "发带图动态"],
  ["social.js", "follow", "关注"],
  ["social.js", "sendDm", "发私信"],
  ["likes.js", "give", "点赞"],
  ["retract.js", "comment", "删评论"],
  ["retract.js", "dynamic", "删动态"],
];

for (const [f, fn, label] of WRITE_FUNCS) {
  t(`${label}（${fn}）自己有 risk.check`, () => {
    const body = funcBody(codeOf(f), fn);
    assert.ok(body, `${f} 里找不到 ${fn}`);
    assert.ok(/risk\.check\s*\(/.test(body), `${label} 函数内部没有 risk.check`);
  });

  t(`${label}（${fn}）自己有 risk.record`, () => {
    const body = funcBody(codeOf(f), fn);
    assert.ok(body, `${f} 里找不到 ${fn}`);
    assert.ok(/risk\.record\s*\(/.test(body), `${label} 函数内部没有 risk.record`);
  });
}

console.log("\n[3b] 预演不该被冷却拦");

t("publishComment 的 check 在 live 判断之后", () => {
  const body = funcBody(codeOf("publish.js"), "publishComment");
  const iLive = body.indexOf("if (!live)");
  const iCheck = body.indexOf("risk.check");
  assert.ok(iLive > 0, "找不到 if (!live)");
  assert.ok(iCheck > 0, "找不到 risk.check");
  assert.ok(iLive < iCheck, "check 在 live 之前 —— 预演会被误拦");
});

t("publishDynamic 的 check 在 live 判断之后", () => {
  const body = funcBody(codeOf("publish.js"), "publishDynamic");
  const iLive = body.indexOf("if (!live)");
  const iCheck = body.indexOf("risk.check");
  assert.ok(iLive > 0 && iCheck > 0);
  assert.ok(iLive < iCheck, "check 在 live 之前 —— 预演会被误拦");
});

console.log("\n[4] 状态可查");

t("status 给界面用的字段齐全", () => {
  const d = mkDir();
  const s = risk.status(d);
  for (const k of ["ok", "level", "note", "hits", "untilAt", "remainMinutes"]) {
    assert.ok(k in s, `缺字段 ${k}`);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
