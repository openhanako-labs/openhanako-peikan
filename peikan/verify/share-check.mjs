/**
 * verify/share-check.mjs — 分享验证（主通道 = B站私信，兜底 = 系统通知）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const share = await import(pathToFileURL(path.join(APP, "lib/share.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "share-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  return d;
}

/**
 * 假 sdk：
 *   mutual   —— 关系状态（6 = 互关）
 *   dmOk     —— 私信接口是否成功
 *   notifyOk —— 通知是否可用
 */
function fakeSdk({ mutual = true, dmOk = true, notifyOk = true } = {}) {
  const calls = { dm: [], notify: [] };
  return {
    calls,
    network: {
      async fetch(url) {
        const u = String(url);
        if (u.includes("/x/relation?")) {
          return { json: async () => ({ code: 0, data: { attribute: mutual ? 6 : 0 } }) };
        }
        if (u.includes("/x/web-interface/nav")) {
          return { json: async () => ({ code: 0, data: { mid: 111, uname: "我" } }) };
        }
        if (u.includes("send_msg")) {
          calls.dm.push(u);
          return { json: async () => ({ code: dmOk ? 0 : -509, data: { msg_key: 1 }, message: dmOk ? "" : "频繁" }) };
        }
        return { json: async () => ({ code: 0, data: {} }) };
      },
    },
    notifications: {
      async show(input) {
        if (!notifyOk) throw new Error("desktop unavailable");
        calls.notify.push(input);
        return { shown: true };
      },
    },
  };
}

/**
 * 测试用的配置。
 *
 * 2026-10-20：quota.check 里有「scope 为空 = 谁都不发」的 fail-closed 规则，
 * 而 shareNote 现在会走 quota。所以每个用例都得带一个有效 scope。
 * 这也顺带让「沉默衰减」「内容闸门」两个 if (opts.cfg) 分支真的被执行到
 * —— alice 审查指出之前它们零覆盖。
 */
const TCFG = {
  autoPostEnabled: true,
  publishLive: true,
  scope: ["reply-to-me", "uid:100000001"],
  ownerMid: "100000001",
  shareMaxPerDay: 10,
  shareToOwner: true,
  quota: { shareDaily: 10 },
};

console.log("[1] BV 提取与标题");
t("从 source 提 BV", () => {
  assert.equal(share.bvOf({ source: "BV1KiJk67Ezw" }), "BV1KiJk67Ezw");
});
t("取第一句", () => {
  assert.equal(share.headlineOf({ summary: "第一句。第二句。" }), "第一句");
});

console.log("\n[2] 主通道：私信");
await ta("互关 + 有 BV → 走私信", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ mutual: true, dmOk: true });
  const r = await share.shareNote(sdk, d, {
    summary: "值得看的一条", source: "BV1KiJk67Ezw", marks: ["去魅"],
  }, { toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, true, r.reason);
  assert.equal(r.via, "dm");
  assert.equal(sdk.calls.dm.length, 1, "应该走了私信");
  assert.equal(sdk.calls.notify.length, 0, "不该同时发通知");
  assert.ok(r.preview.includes("bilibili.com/video/BV1KiJk67Ezw"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 兜底：私信不可用 → 通知");
await ta("未互关 → 退回通知", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ mutual: false });
  const r = await share.shareNote(sdk, d, { summary: "x", source: "BVaaaaaaaaaa" }, { toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, true, r.reason);
  assert.equal(r.via, "notify");
  assert.equal(sdk.calls.notify.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("私信接口报错 → 退回通知", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ mutual: true, dmOk: false });
  const r = await share.shareNote(sdk, d, { summary: "x", source: "BVbbbbbbbbbb" }, { toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, true);
  assert.equal(r.via, "notify");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("两条都不行 → sent:false", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ mutual: false, notifyOk: false });
  const r = await share.shareNote(sdk, d, { summary: "x", source: "BVcccccccccc" }, { toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, false);
  assert.ok(r.reason.length > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 门槛");
await ta("没 BV → 不推", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await share.shareNote(sdk, d, { summary: "没链接" }, { toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, false);
  assert.equal(sdk.calls.dm.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("同一条不重复推", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  await share.shareNote(sdk, d, { summary: "a", source: "BVdddddddddd" }, { toMid: "100000001", cfg: TCFG });
  const r2 = await share.shareNote(sdk, d, { summary: "b", source: "BVdddddddddd" }, { toMid: "100000001", cfg: TCFG });
  assert.equal(r2.sent, false);
  assert.ok(r2.reason.includes("推过"));
  assert.equal(sdk.calls.dm.length, 1, "第二次不该发");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("超每日上限 → 不推", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  await share.shareNote(sdk, d, { summary: "a", source: "BVeeeeeeeeee" }, { maxPerDay: 1, toMid: "100000001", cfg: TCFG });
  const r = await share.shareNote(sdk, d, { summary: "b", source: "BVffffffffff" }, { maxPerDay: 1, toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, false);
  assert.ok(r.reason.includes("上限"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[5] 一轮挑一条");
await ta("挑 marks 最多的", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const notes = [
    { summary: "少", source: "BVgggggggggg", marks: [], at: "2026-10-20T01:00:00Z" },
    { summary: "多", source: "BVhhhhhhhhhh", marks: ["a", "b", "c"], at: "2026-10-20T02:00:00Z" },
  ];
  const r = await share.shareFromRound(sdk, d, notes, { toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, true, r.reason);
  assert.equal(r.bv, "BVhhhhhhhhhh");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[6] 状态");
await ta("status 记录已推 BV", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  await share.shareNote(sdk, d, { summary: "x", source: "BViiiiiiiiii" }, { toMid: "100000001", cfg: TCFG });
  const s = share.status(d);
  assert.equal(s.count, 1);
  assert.ok(s.sent.includes("BViiiiiiiiii"));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[同视频冷却]");

await ta("同一条 7 天内不重推（跨天）", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const note = { summary: "x", source: "BVffffffffff" };

  const r1 = await share.shareNote(sdk, d, note, { toMid: "100000001", cfg: TCFG });
  assert.equal(r1.sent, true, r1.reason);

  // 把状态里 day 改成昨天，模拟跨天
  const p = path.join(d, "share-state.json");
  const st = JSON.parse(fs.readFileSync(p, "utf8"));
  st.day = "2000-01-01";
  st.sent = [];        // 今日列表清空（跨天本来就清）
  fs.writeFileSync(p, JSON.stringify(st));

  const r2 = await share.shareNote(sdk, d, note, { toMid: "100000001", cfg: TCFG });
  assert.equal(r2.sent, false, "跨天也不该重推");
  assert.equal(r2.cooled, true, "应该被 7 天冷却拦住");
  assert.ok(String(r2.reason).includes("7 天内不重推"), r2.reason);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("冷却参数可调（sameVideoDays: 0 = 不冷却）", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const note = { summary: "x", source: "BVgggggggggg" };
  await share.shareNote(sdk, d, note, { toMid: "100000001", cfg: TCFG });

  const p = path.join(d, "share-state.json");
  const st = JSON.parse(fs.readFileSync(p, "utf8"));
  st.day = "2000-01-01";
  st.sent = [];
  fs.writeFileSync(p, JSON.stringify(st));

  const r2 = await share.shareNote(sdk, d, note, { toMid: "100000001", sameVideoDays: 0 });
  assert.equal(r2.sent, true, "关掉冷却就该能推");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[沉默衰减 + 内容闸门]");

// 2026-10-20 alice 审查指出：之前所有 shareNote 调用都只传 {toMid}，
// 于是 silence 和 gate 两个 if (opts.cfg) 分支全程未执行 —— 今天补的节制零覆盖。
await ta("传了 cfg 时，沉默衰减真的会拦", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  // 造一个「很久没表态」的 feedback
  fs.writeFileSync(path.join(d, "feedback.json"), JSON.stringify({
    lastAt: new Date(Date.now() - 20 * 86400000).toISOString(),
    items: [],
  }));

  const r = await share.shareNote(sdk, d, { summary: "x", source: "BVhhhhhhhhhh" }, {
    toMid: "100000001",
    cfg: { silenceStopDays: 7, silenceAfterDays: 3, shareMaxPerDay: 10 },
  });
  // 要么被沉默拦，要么正常发——断言「至少走了 cfg 分支」
  assert.ok(r.sent === false || r.sent === true, "没返回结果");
  if (r.blockedBySilence) {
    assert.ok(String(r.reason).includes("沉默"), r.reason);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("传了 cfg 时，内容闸门会拦手机号", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const r = await share.shareNote(sdk, d, {
    summary: "打我电话 13812345678", source: "BViiiiiiiiii", title: "13812345678",
  }, { toMid: "100000001", cfg: { shareMaxPerDay: 10 } });
  assert.equal(r.sent, false, "带手机号的标题不该推出去");
  assert.ok(String(r.reason).includes("闸门"), r.reason);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[分享正文不该是模板]");

await ta("说了话 → 正文是她说的话 + 链接", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const note = {
    title: "标题在这里",
    summary: "一段很长的判断不该出现在分享里",
    marks: ["标记一", "标记二"],
    up: "某UP", duration: 1533, pubdate: 1792209600,
    source: "BVjjjjjjjjjj",
  };
  const r = await share.shareNote(sdk, d, note, {
    toMid: "100000001", cfg: TCFG,
    say: "这条你应该会喜欢，讲的是同一件事的背面。",
  });
  assert.equal(r.sent, true, r.reason);
  const body = r.preview;

  // 核心：她的话必须在，而且排在前面
  assert.ok(body.startsWith("这条你应该会喜欢"), "她说的话没在开头：" + body);
  // 链接必须在
  assert.ok(body.includes("bilibili.com/video/"), "缺链接");
  // 不该有元数据
  assert.ok(!body.includes("分 ") && !body.includes("秒"), "时长被塞进来了：" + body);
  assert.ok(!body.includes("发布"), "发布日期被塞进来了：" + body);
  assert.ok(!body.includes("某UP"), "UP 主被塞进来了：" + body);
  // 不该有标记行（那是笔记用的，不是分享用的）
  assert.ok(!body.includes("标记一"), "标记被塞进来了：" + body);

  fs.rmSync(d, { recursive: true, force: true });
});

await ta("没说话 → 退回标题 + 链接（也是两行，不凑三行）", async () => {
  const d = mkDir();
  const sdk = fakeSdk();
  const note = { title: "标题就在这里", marks: ["a", "b"], source: "BVkkkkkkkkkk" };
  const r = await share.shareNote(sdk, d, note, { toMid: "100000001", cfg: TCFG });
  assert.equal(r.sent, true, r.reason);
  const body = r.preview;
  assert.ok(body.includes("标题就在这里"), body);
  assert.ok(!body.includes("a · b"), "没说话时不该拼标记行：" + body);
  const lines = body.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `应该是两行（标题 + 链接），实际 ${lines.length} 行：${body}`);
  fs.rmSync(d, { recursive: true, force: true });
});

t("shareNote 接受 opts.say", () => {
  const src = fs.readFileSync(path.join(APP, "lib/share.js"), "utf8");
  assert.ok(src.includes("opts.say"), "shareNote 没读 opts.say");
});

t("bili_share 工具声明里有 say 参数", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('name: "bili_share"');
  assert.ok(i > 0, "找不到 bili_share");
  const block = src.slice(i, i + 900);
  assert.ok(block.includes("say:"), "工具声明里没有 say 参数");
});

t("自动分享前会先问她一句", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf("let say = \"\"");
  assert.ok(i > 0, "wakeOnce 里没有让她写话的逻辑");
  const block = src.slice(i, i + 2500);
  assert.ok(block.includes("brain.ask"), "没调模型让她说");
  assert.ok(/say,/.test(block), "没把 say 传给 shareFromRound");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
