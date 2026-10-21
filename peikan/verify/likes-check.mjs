/**
 * verify/likes-check.mjs — 点赞验证
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const likes = await import(pathToFileURL(path.join(APP, "lib/likes.js")).href);
const quota = await import(pathToFileURL(path.join(APP, "lib/quota.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "like-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  return d;
}

function fakeSdk({ code = 0, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    network: {
      async fetch(url, init) {
        calls.push({ url: String(url), body: init?.body });
        if (fail) throw new Error("网络断了");
        return { json: async () => ({ code, data: {}, message: code === 0 ? "" : "出错了" }) };
      },
    },
  };
}

const OPEN = { autoPostEnabled: true, publishLive: true, scope: ["uid:100000001"], quotaLike: 5 };

console.log("[1] 闸门");
await ta("kill switch 关 → 不点赞", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await likes.give(sdk, d, { bvid: "BV1xx", live: true, config: { autoPostEnabled: false, scope: ["uid:1"] } });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(sdk.calls.length, 0, "不该发请求");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("白名单空 → 不点赞", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await likes.give(sdk, d, { bvid: "BV1xx", live: true, config: { autoPostEnabled: true, scope: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(sdk.calls.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 预演 vs 真发");
await ta("默认预演，不发请求", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  // 用不认识 publishLive 的配置 = 真发开关关着
  const r = await likes.give(sdk, d, { bvid: "BV1aa", config: { ...OPEN, publishLive: false } });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "dry-run");
  assert.ok(r.preview.body.includes("like=1"));
  assert.ok(!r.preview.body.includes("J"), "csrf 必须打码");
  assert.equal(sdk.calls.length, 0, "预演不该发请求");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("live=true + 真发开关开 → 真发", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ code: 0 });
  const r = await likes.give(sdk, d, { bvid: "BV1bb", live: true, config: OPEN });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, "live");
  assert.equal(sdk.calls.length, 1);
  assert.ok(sdk.calls[0].body.includes("like=1"));
  assert.ok(sdk.calls[0].body.includes("bvid=BV1bb"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 已有赞不算失败");
await ta("code=65006（重复点赞）→ ok 且标 already", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ code: 65006 });
  const r = await likes.give(sdk, d, { bvid: "BV1cc", live: true, config: OPEN });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.already, true);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 网络异常不静默");
await ta("fetch 抛错 → ok:false 且有 error", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ fail: true });
  const r = await likes.give(sdk, d, { bvid: "BV1dd", live: true, config: OPEN });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).length > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[5] 配额独立计账");
await ta("赞 5 次后第 6 次被拦", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ code: 0 });
  const cfg = { ...OPEN, bvid: undefined };
  for (let i = 0; i < 5; i += 1) {
    const r = await likes.give(sdk, d, { bvid: `BV1e${i}`, live: true, config: cfg });
    assert.equal(r.ok, true, `第 ${i + 1} 次: ${r.error || r.reason}`);
  }
  const r6 = await likes.give(sdk, d, { bvid: "BV1e5", live: true, config: cfg });
  assert.equal(r6.ok, false, "第 6 次该被拦");
  assert.ok(String(r6.reason || r6.error).includes("上限"), String(r6.reason || r6.error));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("like 默认上限是 5 不是 0", () => {
  assert.equal(quota.DEFAULTS.like, 5);
});
await ta("status 里有 like 一类", async () => {
  const d = mkDir();
  const s = quota.status(d, OPEN);
  assert.ok(s.caps.like, "status 缺 like");
  assert.equal(s.caps.like.cap, 5);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[6] 收到赞（只读）");
await ta("解析 latest+total 合并、去重", async () => {
  const d = mkDir();
  const now = Math.floor(Date.now() / 1000);
  const sdk = {
    network: {
      async fetch() {
        return {
          json: async () => ({
            code: 0,
            data: {
              latest: { items: [{ id: 1, like_time: now, counts: 3, item: { title: "A" }, users: [{ mid: 100000001, nickname: "测试用户" }] }] },
              total: { items: [{ id: 1, like_time: now, counts: 3, item: { title: "A" }, users: [{ mid: 100000001, nickname: "测试用户" }] }, { id: 2, like_time: now, counts: 1, item: { title: "B" }, users: [{ mid: 9, nickname: "路人" }] }] },
            },
          }),
        };
      },
    },
  };
  const r = await likes.received(sdk, d, { hours: 24, ownerMid: "100000001" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.total, 2, "应该去重成 2 条");
  assert.equal(r.fromOwner, 1, "应该识别出主人赞了 1 条");
  assert.ok(r.hint.includes("主人"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("超出时间窗的过滤掉", async () => {
  const d = mkDir();
  const old = Math.floor(Date.now() / 1000) - 100 * 3600;
  const sdk = {
    network: {
      async fetch() {
        return { json: async () => ({ code: 0, data: { latest: { items: [{ id: 9, like_time: old, counts: 1, users: [] }] } } }) };
      },
    },
  };
  const r = await likes.received(sdk, d, { hours: 24 });
  assert.equal(r.total, 0);
  assert.ok(r.hint.includes("没人赞"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[7] 取消赞");
await ta("取消赞默认预演", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await likes.cancel(sdk, d, { bvid: "BV1ff", config: OPEN });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "dry-run");
  assert.equal(sdk.calls.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("取消赞真发用 like=2", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await likes.cancel(sdk, d, { bvid: "BV1gg", live: true, config: OPEN });
  assert.equal(r.ok, true, r.error);
  assert.ok(sdk.calls[0].body.includes("like=2"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[8] 本地账（她赞过什么）");
await ta("remember + history 往返", async () => {
  const d = mkDir();
  likes.remember(d, { bvid: "BV1hh", note: "赞" });
  likes.remember(d, { bvid: "BV1ii", note: "赞" });
  const h = likes.history(d);
  assert.equal(h.length, 2);
  assert.equal(h[0].bvid, "BV1ii", "最新的在前");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
