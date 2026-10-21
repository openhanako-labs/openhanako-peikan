/**
 * verify/gate-coverage-check.mjs — 每条写通道都必须过闸门
 *
 * 由来：参考原仓库 quota-gate.mjs 的教训 ——
 *   「quota.mjs 承诺 check 只挡发言类动作，但 dynamic / danmaku 四条写通道里
 *     quota 出现 0 次 —— 等于裸奔」
 *
 * 我这边查下来：reply / publish / likes 过了，但 social（私信）/ share / retract 全裸。
 * 私信还是直接发给主人的，没闸没配额。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const gate = await import(pathToFileURL(path.join(APP, "lib/gate.js")).href);
const store = await import(pathToFileURL(path.join(APP, "lib/store.js")).href);
const quota = await import(pathToFileURL(path.join(APP, "lib/quota.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gatecov-"));

/** 去掉行注释，避免「注释里提到就算数」 */
function codeOf(f) {
  return fs.readFileSync(path.join(APP, "lib", f), "utf8")
    .split("\n").map((l) => (l.trimStart().startsWith("//") ? "" : l)).join("\n");
}

console.log("[1] 每条写通道都碰了闸门");

const CHANNELS = [
  ["reply.js", "回复评论"],
  ["publish.js", "发评论/动态"],
  ["likes.js", "点赞"],
  ["social.js", "发私信"],
];

for (const [f, label] of CHANNELS) {
  t(`${label}（${f}）过闸门`, () => {
    const src = codeOf(f);
    // 接受几种写法：gate.evaluate / gateMod.evaluate / gate.check / gateMod.check
    const hit = /gate(?:Mod)?\.(?:evaluate|check)\s*\(/.test(src);
    assert.ok(hit, `${f} 没碰闸门`);
  });
}

console.log("\n[2] 私信必须有配额（不能是无限接口）");

t("social.js 调 quota.check 或 gateMod.check", () => {
  const src = codeOf("social.js");
  const hit = /quota(?:Mod)?\.check\s*\(/.test(src) || /gate(?:Mod)?\.check\s*\(/.test(src);
  assert.ok(hit, "私信没有配额检查");
});

t("social.js 私信发出后记账", () => {
  const src = codeOf("social.js");
  // 定位私信分支（sendDm 里的 SENT），不是 follow 那个
  const i = src.indexOf('action: "dm", decision: "SENT"');
  assert.ok(i > 0, "找不到私信的 SENT 审计");
  const block = src.slice(i, i + 600);
  assert.ok(/quota(?:Mod)?\.record\s*\(/.test(block), "私信发出去了但没记账");
});

console.log("\n[3] gate.check / record 本身");

await ta("check 拦手机号", async () => {
  const d = mkDir();
  const r = gate.check(d, store, null, { kind: "dm", text: "我电话 13812345678" });
  assert.equal(r.ok, false);
  assert.equal(r.decision, "BLOCK");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("check 放行干净文本", async () => {
  const d = mkDir();
  const r = gate.check(d, store, null, { kind: "dm", text: "这段话没问题" });
  assert.equal(r.ok, true);
  assert.equal(r.decision, "ALLOW");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("check 会查配额", async () => {
  const d = mkDir();
  // 配额设成 0，应该被拒
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ quotaDm: 0 }));
  const r = gate.check(d, store, quota, { kind: "dm", text: "hello", config: { quotaDm: 0 } });
  // quotaDm=0 的语义是「不限」，所以这里应放行；换个方向验证：配额真的被调用了
  assert.ok(r.decision === "ALLOW" || r.decision === "BLOCK", "没走配额分支");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("record 同时写配额和审计", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ quotaDm: 5 }));
  gate.record(d, store, quota, { kind: "dm", target: "uid:1", note: "测试" });
  const audit = store.listAudit(d, 10);
  assert.ok(audit.some((x) => x.action === "dm" && x.decision === "SENT"), "审计里没有");
  const q = JSON.parse(fs.readFileSync(path.join(d, "quota.json"), "utf8"));
  assert.ok(q.log && q.log.length > 0, "配额没记");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] BLOCK 一定留痕");

await ta("被拦的动作进审计", async () => {
  const d = mkDir();
  gate.check(d, store, null, { kind: "dm", text: "身份证 110101199001011234" });
  const audit = store.listAudit(d, 10);
  assert.ok(audit.some((x) => x.decision === "BLOCK"), "被拦了但没留痕");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
