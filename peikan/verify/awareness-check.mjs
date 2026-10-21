/**
 * verify/awareness-check.mjs — 她对外界的感知是否完整
 *
 * 由来（2026-10-20）：她写完笔记、发完评论，拿不到任何回应。
 * 人处在这种状态里，会慢慢不知道自己在对谁说话。
 *
 * 三件事：
 *   ① 回响（echo）—— 她说过的话有没有人理
 *   ② 粉丝（fans）—— 谁在关注她
 *   ③ 今天（my_day）—— 她今天过到哪了
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const reach = await import(pathToFileURL(path.join(APP, "lib/reach.js")).href);
const fans = await import(pathToFileURL(path.join(APP, "lib/fans.js")).href);
const store = await import(pathToFileURL(path.join(APP, "lib/store.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aware-"));

console.log("[1] 回响：她说过的话有没有人理");

await ta("没发过东西 → 一句诚实的话", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  const r = await reach.echo({ network: {} }, d, { withDetail: false });
  assert.equal(r.ok, true);
  assert.equal(r.summary.total, 0);
  const line = reach.echoLine(r);
  assert.ok(line.includes("还没公开发过"), line);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("发过但没人理 → 不说「没人看」", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  store.audit(d, { action: "comment", decision: "SENT", rpid: "111", oid: "222", bvid: "BV1x" });
  const r = await reach.echo({ network: {} }, d, { withDetail: false });
  assert.equal(r.summary.total, 1);
  assert.equal(r.summary.answered, 0);
  const line = reach.echoLine(r);
  assert.ok(line.includes("暂时还没人回"), line);
  assert.ok(line.includes("不等于没人看"), "不能让她以为没人看：" + line);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("有人回过 → 说清楚多少条", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  store.audit(d, { action: "comment", decision: "SENT", rpid: "111", oid: "222" });
  store.audit(d, { action: "comment", decision: "SENT", rpid: "333", oid: "444" });

  const sdk = {
    network: {
      async fetch(url) {
        // 第一条有人回 + 被赞，第二条没有
        if (String(url).includes("root=111")) {
          return { json: async () => ({ code: 0, data: { root: { like: 3 }, replies: [{ member: { uname: "甲" }, content: { message: "说得好" }, like: 1 }] } }) };
        }
        return { json: async () => ({ code: 0, data: { root: { like: 0 }, replies: [] } }) };
      },
    },
  };
  const r = await reach.echo(sdk, d, { withDetail: true });
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.answered, 1, "应该算出 1 条有人回");
  assert.equal(r.summary.liked, 1, "应该算出 1 条被赞");
  const line = reach.echoLine(r);
  assert.ok(line.includes("有人回过"), line);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("DRY_RUN 的不算她发过的", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  store.audit(d, { action: "comment", decision: "DRY_RUN", rpid: "111" });
  const r = await reach.echo({ network: {} }, d, { withDetail: false });
  assert.equal(r.summary.total, 0, "预演不该算");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("被拦的（BLOCK）也不算", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  store.audit(d, { action: "comment", decision: "BLOCK", rpid: "111" });
  const r = await reach.echo({ network: {} }, d, { withDetail: false });
  assert.equal(r.summary.total, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 粉丝");

await ta("首次只看基线，不谎报新增", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  const sdk = {
    network: {
      async fetch(url) {
        if (String(url).includes("nav")) return { json: async () => ({ code: 0, data: { mid: 999 } }) };
        if (String(url).includes("relation/stat")) return { json: async () => ({ code: 0, data: { follower: 12, following: 3 } }) };
        if (String(url).includes("relation/fans")) {
          return { json: async () => ({ code: 0, data: { list: [{ mid: 1, uname: "甲" }, { mid: 2, uname: "乙" }], total: 2 } }) };
        }
        return { json: async () => ({ code: 0, data: {} }) };
      },
    },
  };
  const r = await fans.newSinceLast(sdk, d, {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.firstTime, true, "第一次应该是基线");
  assert.equal(r.items.length, 0, "首次不该报「新增」");
  assert.ok(String(r.note).includes("基线"), r.note);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("第二次能报出新增", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  let people = [{ mid: 1, uname: "甲" }];
  const sdk = {
    network: {
      async fetch(url) {
        if (String(url).includes("nav")) return { json: async () => ({ code: 0, data: { mid: 999 } }) };
        if (String(url).includes("relation/stat")) return { json: async () => ({ code: 0, data: { follower: people.length, following: 3 } }) };
        if (String(url).includes("relation/fans")) return { json: async () => ({ code: 0, data: { list: people, total: people.length } }) };
        return { json: async () => ({ code: 0, data: {} }) };
      },
    },
  };
  await fans.newSinceLast(sdk, d, {});
  people = [{ mid: 1, uname: "甲" }, { mid: 3, uname: "丙" }];
  const r2 = await fans.newSinceLast(sdk, d, {});
  assert.equal(r2.firstTime, false);
  assert.equal(r2.items.length, 1, "应该报出 1 个新增");
  assert.equal(r2.items[0].name, "丙");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("粉丝列表被风控 → 明确说看不到，不装没人", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "s", bili_jct: "j" }));
  const sdk = {
    network: {
      async fetch(url) {
        if (String(url).includes("nav")) return { json: async () => ({ code: 0, data: { mid: 999 } }) };
        if (String(url).includes("relation/stat")) return { json: async () => ({ code: 0, data: { follower: 50 } }) };
        return { json: async () => ({ code: -352, message: "风控校验失败" }) };
      },
    },
  };
  const r = await fans.newSinceLast(sdk, d, {});
  assert.equal(r.ok, true, "统计拿到就算 ok");
  assert.equal(r.follower, 50, "至少粉丝数是准的");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 接线");

t("三个工具都进了她的 TOOLS", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf("const TOOLS = [");
  const j = src.indexOf("];", i);
  const block = src.slice(i, j);
  for (const nm of ["bili_echo", "bili_fans", "bili_my_day"]) {
    assert.ok(block.includes(`name: "${nm}"`), `${nm} 没进 TOOLS`);
  }
});

t("三个都有执行器", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  for (const nm of ["bili_echo", "bili_fans", "bili_my_day"]) {
    assert.ok(src.includes(`if (name === "${nm}")`), `${nm} 没执行器`);
  }
});

t("带图动态也进了她的 TOOLS", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf("const TOOLS = [");
  const j = src.indexOf("];", i);
  assert.ok(src.slice(i, j).includes('name: "bili_dynamic_image"'), "带图动态没进");
});

t("每日摘要 handler 注册了", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  assert.ok(src.includes("digest: \"digest.daily\""), "KEYS 里没有 digest");
  assert.ok(src.includes("KEYS.digest"), "没有注册 handler");
  assert.ok(src.includes("22, 0, 0, 0"), "没有排 22:00");
});

t("digestToOwner 可配", () => {
  const cfg = fs.readFileSync(path.join(APP, "lib/config.js"), "utf8");
  assert.ok(cfg.includes("digestToOwner"), "config 里没有这个键");
  const st = fs.readFileSync(path.join(APP, "lib/settings.js"), "utf8");
  assert.ok(st.includes("digestToOwner"), "设置里不能改");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
