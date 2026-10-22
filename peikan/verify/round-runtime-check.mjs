/**
 * verify/round-runtime-check.mjs — 回合隔离·运行时实证（P0，2026-10-22）
 *
 * 上面的 round-decouple-check.mjs 是结构断言（查工具表里有没有那只手）。
 * 这个是**运行时实证**：真调 makeToolRunner 返回的 runTool，喂给模型那个回合，
 * 确认哪怕模型在错误回合调写手，也会被挡。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const wake = await import(pathToFileURL(path.join(APP, "lib/wake.js")).href);
const auth = await import(pathToFileURL(path.join(APP, "lib/auth.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "roundrt-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  fs.writeFileSync(path.join(d, "identity.json"), JSON.stringify({ agentId: "a1", agentName: "奥菲莉娅" }));
  fs.writeFileSync(path.join(d, "persona.md"), "你是奥菲莉娅。");
  fs.mkdirSync(path.join(d, "notes"), { recursive: true });
  fs.writeFileSync(path.join(d, "notes", "index.json"), "[]");
  return d;
}

/** 最小 sdk：只提供 auth 需要的 network（这里我们不让它真发请求） */
const mkSdk = () => ({
  network: {
    async fetch() { throw new Error("不应发起真实网络请求（被回合门挡住，根本没到网络层）"); },
  },
});

console.log("[1] social 回合里调 bili_share → 被挡（不触网）");
await ta("runTool('bili_share') in social 返回拒绝", async () => {
  const d = mkDir();
  const sdk = mkSdk();
  const runTool = wake.makeToolRunner(sdk, d, { round: "social" });
  const out = await runTool("bili_share", { bv: "BV1xx" });
  assert.ok(String(out).includes("只回话"), "social 回合的 bili_share 应返回回话提示，实际：" + out);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] content 回合里调 bili_reply → 被挡（不触网）");
await ta("runTool('bili_reply') in content 返回拒绝", async () => {
  const d = mkDir();
  const sdk = mkSdk();
  const runTool = wake.makeToolRunner(sdk, d, { round: "content" });
  const out = await runTool("bili_reply", { to: "x", text: "你好" });
  assert.ok(String(out).includes("不负责回话"), "content 回合的 bili_reply 应返回回话提示，实际：" + out);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] social 回合里调 bili_comment → 被挡");
await ta("runTool('bili_comment') in social 返回拒绝", async () => {
  const d = mkDir();
  const sdk = mkSdk();
  const runTool = wake.makeToolRunner(sdk, d, { round: "social" });
  const out = await runTool("bili_comment", { bv: "BV1yy", text: "说句吧" });
  // bili_comment 不在 round 门里显式拦，但 social 回合的工具表里没有它——模型根本拿不到。
  // 这里测的是：万一模型绕过表直接调，也要有兜底。看它返回什么。
  assert.ok(typeof out === "string" && out.length > 0, "social 回合调 comment 不该真发");
  // 不能真发：如果返回里带「发了/ok」，就是漏了
  assert.ok(!/已发|发出去|sent|ok：/.test(String(out)), "comment 在 social 回合发了：" + out);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] content 回合里 bili_share 正常走（要 sdk；这里给它一个能返回空推荐的假 network）");
await ta("content 回合 bili_share 能进入正常流程", async () => {
  const d = mkDir();
  const sdk = {
    network: {
      async fetch(url) {
        const u = String(url);
        if (u.includes("/x/relation?")) return { json: async () => ({ code: 0, data: { attribute: 6 } }) };
        if (u.includes("/x/web-interface/nav")) return { json: async () => ({ code: 0, data: { mid: 111, uname: "我" } }) };
        if (u.includes("send_msg")) return { json: async () => ({ code: 0, data: { msg_key: 1 } }) };
        return { json: async () => ({ code: 0, data: {} }) };
      },
    },
    notifications: { async show() { return { shown: true }; } },
  };
  const runTool = wake.makeToolRunner(sdk, d, { round: "content", shareToOwner: true, ownerMid: "100000001" });
  await fs.promises.writeFile(path.join(d, "notes", "index.json"), JSON.stringify([{
    source: "BV1zz", title: "一条", summary: "内容", at: new Date().toISOString(), id: "n_x",
  }]));
  const out = await runTool("bili_share", {});
  // 有笔记且互关 → 应进入分享流程（返回「递过去了」或失败原因）
  assert.ok(typeof out === "string", "content 回合 bili_share 应可执行");
  assert.ok(!out.includes("只回话"), "content 回合不该被回合门拦：" + out);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);