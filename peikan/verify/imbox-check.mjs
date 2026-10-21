/**
 * verify/imbox-check.mjs — 私信读取
 *
 * 背景（2026-10-20）：她之前只能发私信、不能读。
 * 你私信她，她永远不知道——那不是「少个功能」，是「她不在场」。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const im = await import(pathToFileURL(path.join(APP, "lib/imbox.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "im-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  return d;
};

const ME = "100000002";
const OWNER = "100000001";

/** 假 sdk：模拟 nav + sessions + messages */
function fakeSdk({ sessions = [], msgs = {} } = {}) {
  return {
    network: {
      async fetch(url) {
        const u = String(url);
        if (u.includes("/x/web-interface/nav")) {
          return { json: async () => ({ code: 0, data: { mid: ME, uname: "我" } }) };
        }
        if (u.includes("get_sessions")) {
          return { text: async () => JSON.stringify({ code: 0, data: { session_list: sessions } }) };
        }
        if (u.includes("fetch_session_msgs")) {
          const mid = new URL(u).searchParams.get("talker_id");
          return { text: async () => JSON.stringify({ code: 0, data: { messages: msgs[mid] || [] } }) };
        }
        return { json: async () => ({ code: 0, data: {} }) };
      },
    },
  };
}

const sess = (mid, unread, lastText) => ({
  talker_id: String(mid),
  unread_count: unread,
  account_info: { name: "" },
  session_ts: 1792475788574619,
  last_msg: { content: JSON.stringify({ content: lastText }) },
});

const msg = (sender, content, ts) => ({
  msg_key: String(ts),
  // ⚠️ 不能用 Number()：19 位的 mid 超出 JS 安全整数范围（2^53），会丢精度。
  //   B站 真实返回的 sender_uid 是 number，但值刚好在安全范围内才不会出错。
  //   测试里直接保留字符串，代码那边 String() 一下就行。
  sender_uid: String(sender),
  timestamp: ts,
  msg_type: 1,
  content: JSON.stringify({ content }),
});

console.log("[1] 会话列表");
await ta("能解析会话，并识别系统通知", async () => {
  const d = mkDir();
  const sdk = fakeSdk({
    sessions: [
      sess(OWNER, 1, "我一般不怎么看这类视频）"),
      sess("844424930131964", 0, "你的账号在新设备或平台登录成功"),
    ],
  });
  const r = await im.sessions(sdk, d);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.sessions.length, 2);
  assert.equal(r.sessions[0].mid, OWNER);
  assert.equal(r.sessions[0].system, false, "普通私信不该被当系统通知");
  assert.equal(r.sessions[1].system, true, "登录通知应该标成系统");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("没有凭据 → 明确报错", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "im-"));
  const r = await im.sessions(fakeSdk(), d);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("凭据"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("非 JSON 响应（Method Not Allowed）→ 不炸", async () => {
  const d = mkDir();
  const sdk = {
    network: {
      async fetch(u) {
        if (String(u).includes("nav")) return { json: async () => ({ code: 0, data: { mid: ME } }) };
        return { text: async () => "Method Not Allowed\n" };
      },
    },
  };
  const r = await im.sessions(sdk, d);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("Method") || r.error.includes("JSON"), r.error);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 会话消息");
await ta("区分「我说的」和「对方说的」", async () => {
  const d = mkDir();
  const sdk = fakeSdk({
    msgs: {
      [OWNER]: [
        msg(ME, "第一条私信。", 1792472195),
        msg(OWNER, "收到了）", 1792472697),
      ],
    },
  });
  // messages() 返回的是旧→新（已 reverse），这样「最后一条」才是最新的
  const r = await im.messages(sdk, d, { mid: OWNER });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].fromMe, true, "第一条应该是我说的");
  assert.equal(r.messages[1].fromMe, false, "最后一条应该是对方说的");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("content 是 JSON 字符串也能抠出正文", async () => {
  const d = mkDir();
  const sdk = fakeSdk({ msgs: { [OWNER]: [msg(OWNER, "纯文本正文", 1792472697)] } });
  const r = await im.messages(sdk, d, { mid: OWNER });
  assert.equal(r.messages[0].text, "纯文本正文");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 认出「等着她回」的那些");
await ta("对方说最后一句 → 进 unreplied", async () => {
  const d = mkDir();
  const sdk = fakeSdk({
    sessions: [sess(OWNER, 1, "我一般不怎么看这类视频）")],
    msgs: {
      [OWNER]: [
        msg(ME, "这条视频的热评区比视频本身更能说明问题", 1792470301),
        msg(OWNER, "我一般不怎么看这类视频）", 1792475788),
      ],
    },
  });
  const r = await im.unreplied(sdk, d);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, "我一般不怎么看这类视频）");
  assert.ok(r.items[0].context.length >= 2, "应该带上下文");
  assert.equal(r.items[0].source, "dm");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("她说了最后一句 → 不算待回", async () => {
  const d = mkDir();
  const sdk = fakeSdk({
    sessions: [sess(OWNER, 0, "我的回复")],
    msgs: {
      [OWNER]: [
        msg(OWNER, "你说呢", 1792470000),
        msg(ME, "我的回复", 1792471000),
      ],
    },
  });
  const r = await im.unreplied(sdk, d);
  assert.equal(r.items.length, 0, "她刚回过，不该再催她");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("系统通知不算「有人找她」", async () => {
  const d = mkDir();
  const sdk = fakeSdk({
    sessions: [sess("844424930131964", 0, "登录成功")],
    msgs: {},
  });
  const r = await im.unreplied(sdk, d);
  assert.equal(r.items.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 接线：私信真的被听进去了吗");
t("inbox.tick 里有私信轮询", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  assert.ok(src.includes("imbox.unreplied"), "轮询里没有私信");
});
t("kill switch 关着也要听（只读不等于失聪）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  // 用 handler 注册位置做起点（不能只用 KEYS.inbox —— 它第一次出现是在排程处）
  const i = src.indexOf("sdk.tasks.registerHandler(KEYS.inbox");
  assert.ok(i > 0, "找不到 inbox handler 注册");
  const block = src.slice(i, i + 5000);
  // kill switch 判断必须在「拉取」之后，不能一进来就 return
  const idxPull = block.indexOf("msgfeed.poll");
  const idxKill = block.indexOf("autoPostEnabled !== true");
  assert.ok(idxPull > 0, "找不到拉取");
  assert.ok(idxKill > idxPull, "kill switch 判断在拉取之前 → 她会失聪");
});
t("bili_inbox 同时给评论和私信", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('name === "bili_inbox"');
  const block = src.slice(i, i + 1800);
  assert.ok(block.includes("msgfeed.poll"), "看不到评论");
  assert.ok(block.includes("imbox.unreplied"), "看不到私信");
});
t("bili_reply 能走私信通道", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('name === "bili_reply"');
  const block = src.slice(i, i + 2200);
  assert.ok(block.includes("social.sendDm"), "私信回复没走 sendDm");
});

console.log("\n[私信水位]");

await ta("同一私信第二次不再算新的（onlyNew）", async () => {
  // 直接测 markSeen + status 的契约（不造完整的网络桩）
  const { markSeen } = await import(pathToFileURL(path.join(APP, "lib/imbox.js")).href);
  const imbox = await import(pathToFileURL(path.join(APP, "lib/imbox.js")).href);
  const d = mkDir();

  const before = imbox.status(d);
  assert.equal(before.seenCount, 0, "初始应该没见过任何东西");

  markSeen(d, ["msg_1", "msg_2"]);
  const after = imbox.status(d);
  assert.equal(after.seenCount, 2, "标记后该有 2 条");
  assert.ok(after.lastPollAt, "水位时间该推进");

  fs.rmSync(d, { recursive: true, force: true });
});

await ta("seen 超 500 条会裁掉最老的", async () => {
  const imbox = await import(pathToFileURL(path.join(APP, "lib/imbox.js")).href);
  const d = mkDir();
  for (let i = 0; i < 510; i += 1) imbox.markSeen(d, [`m_${i}`]);
  const s = imbox.status(d);
  assert.ok(s.seenCount <= 500, `该裁到 500 以内，实际 ${s.seenCount}`);
  fs.rmSync(d, { recursive: true, force: true });
});

t("inbox.tick 用 onlyNew 并推水位", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  assert.ok(src.includes("onlyNew: true"), "没传 onlyNew —— 同一条会被反复叫醒");
  assert.ok(src.includes("imbox.markSeen"), "没推水位");
});

console.log("\n[wakeOnce 的调用点必须带 cfg]");

t("rhythm.wake 用 ...cfg 展开（不再手写字段）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  const i = src.indexOf("wake.wakeOnce(sdk, dataDir, {");
  assert.ok(i > 0, "找不到 wakeOnce 调用");
  const block = src.slice(i, i + 600);
  assert.ok(block.includes("...cfg"), "没有 ...cfg 展开 —— 新字段一加就会漏");
  assert.ok(block.includes("ownerMid"), "没显式带 ownerMid");
});

t("inbox.tick 调 wakeOnce 也带 cfg", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  const i = src.indexOf("KEYS.inbox");
  const j = src.indexOf("wake.wakeOnce", i);
  assert.ok(j > 0, "找不到 inbox 里的 wakeOnce");
  const block = src.slice(j, j + 400);
  assert.ok(block.includes("...cfg"), "inbox 里的 wakeOnce 没 ...cfg —— ownerMid 会漏");
});

t("日志把评论和私信都写出来", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  const i = src.indexOf("条新消息（评论");
  assert.ok(i > 0, "日志还是只写评论数 —— 私信被隐了");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
