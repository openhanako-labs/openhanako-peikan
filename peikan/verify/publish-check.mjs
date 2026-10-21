/**
 * verify/publish-check.mjs — 发布层验证（预演为主，不真发）
 *
 * 1. 请求组装正确（参数、csrf、body）
 * 2. WBI 签名能生成
 * 3. 预览脱敏（不泄露凭据）
 * 4. 错误码映射（含停手判定）
 * 5. 真网络：只打 nav，不发评论
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const pub = await import(pathToFileURL(path.join(APP, "lib/publish.js")).href);
const auth = await import(pathToFileURL(path.join(APP, "lib/auth.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const fakeCred = { sessdata: "SECRET_SESS", bili_jct: "SECRET_JCT", buvid3: "SECRET_BUVID" };

console.log("[1] 请求组装");
t("参数齐全", () => {
  const req = pub.buildCommentRequest(fakeCred, { oid: 123, bvid: "BVabc", message: "测试内容" });
  assert.equal(req.params.type, 1);
  assert.equal(req.params.oid, "123");
  assert.equal(req.params.message, "测试内容");
  assert.equal(req.params.csrf, "SECRET_JCT");
  assert.equal(req.params.plat, "1");
});
t("回复带 root/parent", () => {
  const req = pub.buildCommentRequest(fakeCred, { oid: 1, bvid: "BVx", message: "m", root: 11, parent: 22 });
  assert.equal(req.params.root, "11");
  assert.equal(req.params.parent, "22");
});
t("referer 指向视频", () => {
  const req = pub.buildCommentRequest(fakeCred, { oid: 1, bvid: "BVx", message: "m" });
  assert.ok(req.referer.includes("BVx"));
});
t("body 是 urlencoded", () => {
  const req = pub.buildCommentRequest(fakeCred, { oid: 1, bvid: "BVx", message: "带空格 和中文" });
  assert.ok(req.body.includes("message="));
  assert.ok(req.body.includes("%20") || req.body.includes("+"));
});

console.log("\n[2] 预览脱敏");
t("csrf 被打码", () => {
  const req = pub.buildCommentRequest(fakeCred, { oid: 1, bvid: "BVx", message: "m" });
  const p = pub.previewRequest(req, fakeCred);
  assert.ok(!p.body.includes("SECRET_JCT"), "csrf 泄露了");
  assert.ok(p.body.includes("***csrf***"));
});
t("cookie 被打码", () => {
  const req = pub.buildCommentRequest(fakeCred, { oid: 1, bvid: "BVx", message: "m" });
  const p = pub.previewRequest(req, fakeCred);
  assert.ok(!p.cookieMasked.includes("SECRET"));
  assert.ok(p.cookieMasked.includes("***"));
});
t("预览里没有任何原值", () => {
  const req = pub.buildCommentRequest(fakeCred, { oid: 1, bvid: "BVx", message: "m" });
  const s = JSON.stringify(pub.previewRequest(req, fakeCred));
  for (const v of ["SECRET_SESS", "SECRET_JCT", "SECRET_BUVID"]) {
    assert.ok(!s.includes(v), `泄露了 ${v}`);
  }
});

console.log("\n[3] 错误码映射");
t("-101 未登录", () => {
  const r = pub.explainCode(-101);
  assert.ok(r.hint.includes("未登录"));
  assert.equal(r.mustStop, false);
});
t("12015 验证码 → 必须停手", () => {
  const r = pub.explainCode(12015);
  assert.ok(r.hint.includes("验证码"));
  assert.equal(r.mustStop, true);
});
t("-509 频繁 → 必须停手", () => {
  assert.equal(pub.explainCode(-509).mustStop, true);
});
t("未知错误码有兜底", () => {
  const r = pub.explainCode(99999);
  assert.ok(r.hint.includes("未知"));
});
t("-111 csrf 错误有提示", () => {
  assert.ok(pub.explainCode(-111).hint.includes("csrf"));
});

console.log("\n[4] cookie 头构造");
t("默认带 buvid3", () => {
  const h = pub.cookieHeader(fakeCred);
  assert.ok(h.includes("buvid3="));
});
t("omitBuvid3 时摘掉", () => {
  const h = pub.cookieHeader(fakeCred, { omitBuvid3: true });
  assert.ok(!h.includes("buvid3="));
});

console.log("\n[5] 预演模式（真凭据 + 真签名，但不发）");
const dirs = [process.env.OPHELIA_DATA_DIR, process.env.OPHELIA_DATA_DIR || path.join(os.homedir(), ".hanako", "app-data", "peikan"), path.join(os.homedir(), ".hanako", "app-data", "ophelia-bili")].filter(Boolean);
let dataDir = null;
for (const d of dirs) { if (fs.existsSync(path.join(d, "credentials.json"))) { dataDir = d; break; } }

if (!dataDir) {
  console.log("  (跳过：找不到凭据)");
} else {
  const sdk = { network: { async fetch(u, i) { return fetch(u, i); } } };
  try {
    const r = await pub.publishComment(sdk, dataDir, {
      oid: 100000000003, bvid: "BV1xx411c7m3",
      message: "预演测试，不会真的发出。",
      live: false,
    });
    if (r.ok && r.mode === "dry-run") {
      ok(`预演成功（body ${r.preview.bodyLength} 字节，未发送）`);
      console.log(`      URL: ${r.preview.url}`);
      console.log(`      referer: ${r.preview.referer}`);
      console.log(`      cookie: ${r.preview.cookieMasked}`);
    } else {
      bad("预演", JSON.stringify(r).slice(0, 200));
    }
  } catch (e) { bad("预演", e.message); }
}

console.log("\n[6] 动态发布（预演）");
if (dataDir) {
  const sdk = { network: { async fetch(u, i) { return fetch(u, i); } } };
  try {
    const r = await pub.publishDynamic(sdk, dataDir, { text: "预演测试动态", live: false });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "dry-run");
    assert.ok(r.preview.url.includes("create/dyn"));
    assert.equal(r.preview.origin, "https://t.bilibili.com");
    ok("动态预演成功（不真发）");
  } catch (e) { bad("动态预演", e.message); }
  try {
    const r = await pub.publishDynamic(sdk, dataDir, { text: "   ", live: false });
    assert.equal(r.ok, false);
    ok("空正文被拒");
  } catch (e) { bad("空正文", e.message); }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
