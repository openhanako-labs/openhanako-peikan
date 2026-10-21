/**
 * verify/run-check.mjs — P0 行为验证（直连接口，不绕宿主）
 *
 * mock 一个最小 v2 App ctx，跑一遍真实逻辑：
 *   1) 模块可加载
 *   2) gate 三态正确
 *   3) quota check/record 生效
 *   4) store 读写
 *   5) registerTools / registerRoutes / registerTasks 能注册不抛
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const p = (rel) => pathToFileURL(path.join(APP, rel)).href;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophelia-p0-"));

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  \u2713 ${name}`); };
const bad = (name, e) => { fail++; console.log(`  \u2717 ${name} -> ${e?.message ?? e}`); };

async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// ── mock ctx ──────────────────────────────────────────────────────────
const registered = { tools: [], routes: 0, handlers: [], schedules: [] };
const logLines = [];
const logger = { info: (m) => logLines.push(m), warn: (m) => logLines.push(m), error: (m) => logLines.push(m), debug: () => {} };

const configStore = { autoPostEnabled: false };
// P17：配置自持——readConfig 读 dataDir/config.json。
// 测试里 configStore 变化时同步落盘，否则改配置读不到。
const cfgFile = path.join(dataDir, "config.json");
const syncCfg = () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(configStore, null, 2) + "\n");
};
syncCfg();
const ctx = {
  dataDir,
  logger,
  config: {
    get: async (k) => configStore[k],
    getAll: async () => ({ ...configStore }),
  },
  tools: { register: async (tool) => { registered.tools.push(tool); return () => {}; } },
  routes: { register: async (fn) => { registered.routes++; fn(fakeApp); return () => {}; } },
  tasks: {
    registerHandler: async (key) => { registered.handlers.push(key); return () => {}; },
    listSchedules: async () => [],
    schedule: async (s) => { registered.schedules.push(s); return s; },
  },
};
// 极简路由收集器：记录注册了哪些 path
const routePaths = [];
const fakeApp = {
  get: (p) => routePaths.push(`GET ${p}`),
  post: (p) => routePaths.push(`POST ${p}`),
};

// ── 1. 模块加载 ───────────────────────────────────────────────────────
console.log("\n[1] 模块加载");
const gate = await import(p("lib/gate.js"));
const quota = await import(p("lib/quota.js"));
const store = await import(p("lib/store.js"));
const client = await import(p("lib/client.js"));
const auth = await import(p("lib/auth.js"));
const cfgmod = await import(p("lib/config.js"));
await t("gate/quota/store/client/auth/config 均可加载", () => {});

// ── 2. gate 三态 ──────────────────────────────────────────────────────
console.log("\n[2] 闸门三态（确定性）");
await t("正常文本 -> ALLOW", () => {
  const r = gate.evaluate({ text: "今天的风很轻。", kind: "comment" });
  assert.equal(r.decision, "ALLOW");
});
await t("含手机号 -> BLOCK", () => {
  const r = gate.evaluate({ text: "联系我 13800138000", kind: "comment" });
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.hits.includes("phone-like"));
});
await t("含敏感话题 -> HOLD", () => {
  const r = gate.evaluate({ text: "聊聊时政吧", kind: "comment" });
  assert.equal(r.decision, "HOLD");
});
await t("新内容形态(dynamic) -> HOLD", () => {
  const r = gate.evaluate({ text: "第一次发动态", kind: "dynamic" }, { newContentType: true });
  assert.equal(r.decision, "HOLD");
});
await t("空正文 -> HOLD", () => {
  const r = gate.evaluate({ text: "   ", kind: "comment" });
  assert.equal(r.decision, "HOLD");
});

// ── 3. quota ──────────────────────────────────────────────────────────
console.log("\n[3] 配额");
await t("初始可发", () => assert.equal(quota.check(dataDir, { type: "comment", target: "BV:x", config: { scope: ["BV:x","BV:a","BV:b","BV:c"], quota: { comment: 3 } } }).ok, true));
await t("record 后计数增长", () => {
  quota.record(dataDir, { type: "comment", target: "BV:x" });
  const s = quota.status(dataDir);
  assert.equal(s.caps.comment.used, 1);
});
await t("同目标冷却只对分享型生效", () => {
  // 原仓库语义：sameTargetDays 只约束 share 型，普通评论不看这个
  const plain = quota.check(dataDir, { type: "comment", target: "BV:x", config: { scope: ["BV:x"], quota: { comment: 3 } } });
  assert.equal(plain.ok, true, "普通评论不该被同目标冷却拦");
  const share = quota.check(dataDir, { type: "comment", target: "BV:x", share: true, config: { scope: ["BV:x"], quota: { shareDaily: 3, sameTargetDays: 7 } } });
  assert.equal(share.ok, true, "首次分享可发");
});
await t("写满 3 条后 -> 拦", () => {
  quota.record(dataDir, { type: "comment", target: "BV:a" });
  quota.record(dataDir, { type: "comment", target: "BV:b" });
  const r = quota.check(dataDir, { type: "comment", target: "BV:c", config: { scope: ["BV:x","BV:a","BV:b","BV:c"], quota: { comment: 3 } } });
  assert.equal(r.ok, false);
});
await t("未知类型 -> 默认拦", () => {
  assert.equal(quota.check(dataDir, { type: "weird", config: { scope: ["BV:x"], quota: { comment: 3 } } }).ok, false);
});

// ── 4. store ──────────────────────────────────────────────────────────
console.log("\n[4] 本地存储");
await t("写/列笔记", () => {
  store.addNote(dataDir, { summary: "第三城。温度 22。", kind: "video", marks: ["裂隙"] });
  const list = store.listNotes(dataDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].summary, "第三城。温度 22。");
});
await t("写/列草稿", () => {
  const d = store.addDraft(dataDir, { text: "草稿一", kind: "comment" });
  assert.equal(d.status, "draft");
  assert.equal(store.listDrafts(dataDir).length, 1);
});
await t("人审 push/resolve", () => {
  const r = store.pushReview(dataDir, { text: "待拍板", reasons: ["敏感话题"] });
  assert.equal(store.listReview(dataDir, "pending").length, 1);
  store.resolveReview(dataDir, r.id, "resolved");
  assert.equal(store.listReview(dataDir, "pending").length, 0);
});
await t("审计写入/读取", () => {
  store.audit(dataDir, { action: "publish", decision: "BLOCK", reason: "test" });
  const a = store.listAudit(dataDir);
  assert.equal(a.length, 1);
  assert.equal(a[0].decision, "BLOCK");
});
await t("两本日记落盘", () => {
  store.appendDiary(dataDir, "executive", "给你的信");
  store.appendDiary(dataDir, "private", "不加滤镜");
  assert.ok(fs.existsSync(path.join(dataDir, "diary-executive.md")));
  assert.ok(fs.existsSync(path.join(dataDir, "diary-private.md")));
});

// ── 5. auth（不回显）──────────────────────────────────────────────────
console.log("\n[5] 凭据");
await t("未配置时 hasCredentials=false", () => assert.equal(auth.hasCredentials(dataDir), false));
await t("缺字段拒绝写入", () => {
  const r = auth.saveCredentials(dataDir, { sessdata: "x" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["bili_jct"]);
});
await t("完整写入后 hasCredentials=true", () => {
  const r = auth.saveCredentials(dataDir, { sessdata: "S", bili_jct: "J", buvid3: "B" });
  assert.equal(r.ok, true);
  assert.equal(auth.hasCredentials(dataDir), true);
});
await t("save 返回不含凭据值", () => {
  const r = auth.saveCredentials(dataDir, { sessdata: "SECRET", bili_jct: "J", buvid3: "" });
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
});

// ── 6. 注册面 ─────────────────────────────────────────────────────────
console.log("\n[6] 注册面");
const { registerTools } = await import(p("lib/register-tools.js"));
const { registerRoutes } = await import(p("lib/register-routes.js"));
const { registerTasks } = await import(p("lib/register-tasks.js"));

await t("registerTools 注册全部工具", async () => {
  await registerTools(ctx, logger);
  assert.ok(registered.tools.length >= 10, `仅 ${registered.tools.length} 个`);
  const names = registered.tools.map((x) => x.name);
  for (const n of ["bili_health", "bili_publish", "bili_gate", "bili_review", "bili_diary"]) {
    assert.ok(names.includes(n), `缺 ${n}`);
  }
});
await t("registerRoutes 挂载路由", async () => {
  await registerRoutes(ctx, logger);
  assert.ok(routePaths.length >= 6, `仅 ${routePaths.length} 条`);
  assert.ok(routePaths.some((p) => p.endsWith("/health")));
});
await t("registerTasks 注册 handler", async () => {
  await registerTasks(ctx, logger);
  assert.ok(registered.handlers.length >= 3, `仅 ${registered.handlers.length} 个`);
});
await t("kill switch 关闭时不排发布类 schedule（浏览/健康可排）", () => {
  // P3 起：browse.tick / health.tick 是纯读，允许排；发布相关一律不排
  const forbidden = registered.schedules.filter((s) => /publish|post|reply/i.test(String(s.handlerKey || "")));
  assert.equal(forbidden.length, 0, "不应创建发布类 schedule");
});

// ── 7. 发布纵深三道 ───────────────────────────────────────────────────
console.log("\n[7] 发布闸门纵深");
const publishTool = registered.tools.find((x) => x.name === "bili_publish");
const callPublish = async (args) => {
  const out = await publishTool.execute({ ...args, context: {} });
  return JSON.parse(out.content[0].text);
};
await t("kill switch 关 -> 拒", async () => {
  const r = await callPublish({ text: "正常话", kind: "comment" });
  assert.equal(r.decision, "BLOCK");
  assert.ok(String(r.reason).includes("kill switch"));
});
await t("kill switch 开 + 敏感 -> HOLD 并进人审队列", async () => {
  configStore.autoPostEnabled = true;
  syncCfg();
  const before = store.listReview(dataDir, "pending").length;
  const r = await callPublish({ text: "时政新闻", kind: "comment" });
  assert.equal(r.decision, "HOLD");
  assert.equal(store.listReview(dataDir, "pending").length, before + 1);
});
await t("kill switch 开 + 通过 -> 仍不发(P4)", async () => {
  // 用独立 dataDir，避免前面配额用例的污染
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-clean-"));
  const prevDataDir = ctx.dataDir;
  ctx.dataDir = cleanDir;
  configStore.scope = "BV:BVtest";
  configStore.quotaComment = 5;
  syncCfg();
  // 预演需要 network.fetch 取视频信息；用假网络（不真请求）
  ctx.network = {
    async fetch(url) {
      if (String(url).includes("nav")) {
        return { json: async () => ({ code: 0, data: { isLogin: true, uname: "test", mid: 1, wbi_img: { img_url: "https://x/a.png", sub_url: "https://x/b.png" } } }) };
      }
      return { json: async () => ({ code: 0, data: { aid: 1, bvid: "BVtest", cid: 2, title: "t", duration: 60, owner: {}, stat: {} } }) };
    },
  };
  const r = await callPublish({ text: "今天第三城。温度 22 度。", kind: "comment", targetBv: "BVtest" });
  ctx.dataDir = prevDataDir;
  // P5 起：五道全过后进入发布层；默认预演（publishLive=false），所以不该真发
  assert.equal(r.ok, true, `预演应成功：${JSON.stringify(r).slice(0, 120)}`);
  assert.equal(r.stage, "P5");
  assert.equal(r.mode, "dry-run", "默认必须走预演，不能真发");
});

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log(`\n结果：${pass} 通过，${fail} 失败`);
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);












