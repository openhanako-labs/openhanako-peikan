/**
 * verify/dynamic-check.mjs — 带图动态 / 改动态
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const dyn = await import(pathToFileURL(path.join(APP, "lib/dynamic.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dyn-"));

console.log("[1] 图片尺寸解析（不依赖第三方库）");

t("PNG 头解析", () => {
  // 最小 PNG 头：89 50 4E 47 0D 0A 1A 0A + IHDR
  const b = Buffer.alloc(32);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b.writeUInt32BE(1080, 16);
  b.writeUInt32BE(1440, 20);
  const s = dyn.imageSize(b);
  assert.equal(s.width, 1080);
  assert.equal(s.height, 1440);
  assert.equal(s.kind, "png");
});

t("JPEG SOF 段解析", () => {
  // FF D8 + FF C0 len(2) + 精度 + 高 + 宽
  const b = Buffer.alloc(32);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(11, 4);      // 段长
  b[6] = 8;                     // 精度
  b.writeUInt16BE(720, 7);      // 高
  b.writeUInt16BE(1280, 9);     // 宽
  const s = dyn.imageSize(b);
  assert.equal(s.width, 1280);
  assert.equal(s.height, 720);
  assert.equal(s.kind, "jpg");
});

t("认不出的返回 null", () => {
  assert.equal(dyn.imageSize(Buffer.from("not an image at all........")), null);
  assert.equal(dyn.imageSize(Buffer.alloc(4)), null);
});

console.log("\n[2] 预演不发");

await ta("改动态：预演不碰网络", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({
    sessdata: "s", bili_jct: "j", buvid3: "b",
  }));
  let called = 0;
  const sdk = {
    network: {
      async fetch(url) {
        called += 1;
        // 只允许 detail 读
        if (String(url).includes("detail")) {
          return { json: async () => ({ code: 0, data: { item: { modules: { module_dynamic: { major: { type: "opus", opus: { pics: [{ url: "x", width: 10, height: 20 }], summary: { text: "原文" } } } } } } } }) };
        }
        throw new Error("不该发这个请求：" + url);
      },
    },
  };
  const r = await dyn.editDynamic(sdk, d, { dynId: "123", text: "新正文", cfg: { scope: ["x"] }, live: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, "dry-run");
  assert.equal(r.preview.keepPics, 1, "应保留原图");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("带图动态：预演不上传", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({
    sessdata: "s", bili_jct: "j", buvid3: "b",
  }));
  const img = path.join(d, "t.png");
  const b = Buffer.alloc(32);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b.writeUInt32BE(100, 16); b.writeUInt32BE(200, 20);
  fs.writeFileSync(img, b);

  const sdk = { network: { async fetch() { throw new Error("预演不该发请求"); } } };
  const r = await dyn.publishDynamicImage(sdk, d, { text: "带图", imagePath: img, cfg: { scope: ["x"] }, live: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, "dry-run");
  assert.equal(r.preview.image.width, 100);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 闸门");

await ta("含手机号 → BLOCK", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  const sdk = {
    network: {
      async fetch() {
        return { json: async () => ({ code: 0, data: { item: { modules: { module_dynamic: { major: { opus: { pics: [], summary: { text: "" } } } } } } } }) };
      },
    },
  };
  const r = await dyn.editDynamic(sdk, d, { dynId: "1", text: "打我电话 13812345678", cfg: {}, live: true });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.decision, "BLOCK");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("超过 1000 字 → 拒", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  const r = await dyn.editDynamic({ network: {} }, d, { dynId: "1", text: "字".repeat(1001), cfg: {}, live: true });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("1000"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 工具接线");

t("两个工具都注册了", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  assert.ok(src.includes('name: "bili_edit_dynamic"'), "缺 bili_edit_dynamic");
  assert.ok(src.includes('name: "bili_dynamic_image"'), "缺 bili_dynamic_image");
});

t("两个工具都要 publishLive 才真发", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  for (const nm of ["bili_edit_dynamic", "bili_dynamic_image"]) {
    const i = src.indexOf(`name: "${nm}"`);
    const block = src.slice(i, i + 1600);
    assert.ok(block.includes("publishLive"), `${nm} 没检查 publishLive`);
  }
});

t("comment_digest 也注册了", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  assert.ok(src.includes('name: "bili_comment_digest"'), "缺 comment_digest");
});

console.log("\n[5] 回读楼层");

t("msgfeed 有 resolveReply", () => {
  const src = fs.readFileSync(path.join(APP, "lib/msgfeed.js"), "utf8");
  assert.ok(src.includes("export async function resolveReply"), "缺 resolveReply");
  assert.ok(src.includes("reply/reply"), "端点不对");
});

t("收件箱正文为空时会回读", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('if (name === "bili_inbox")');
  const block = src.slice(i, i + 2200);
  assert.ok(block.includes("resolveReply"), "bili_inbox 没回读楼层");
});

console.log("\n[6] 报错翻译成人话");

t("500 + only_fans → 这条不存在", () => {
  const s = dyn.explainDynamicError(500, "Cannot read property 'only_fans' of undefined");
  assert.ok(s.includes("不存在"), "没翻译对：" + s);
  assert.ok(!s.includes("only_fans"), "不该把原始报错揃出去");
});

t("纯 500 → B站 那边出错", () => {
  const s = dyn.explainDynamicError(500, "Internal Server Error");
  assert.ok(s.includes("B站"), s);
});

t("-101 → 登录态失效", () => {
  assert.ok(dyn.explainDynamicError(-101, "").includes("登录"), dyn.explainDynamicError(-101, ""));
});

t("-111 → 限流", () => {
  assert.ok(dyn.explainDynamicError(-111, "").includes("限流"), dyn.explainDynamicError(-111, ""));
});

t("认不出的带上 code 和原文", () => {
  const s = dyn.explainDynamicError(99999, "奇怪的事");
  assert.ok(s.includes("99999"), s);
  assert.ok(s.includes("奇怪的事"), s);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
