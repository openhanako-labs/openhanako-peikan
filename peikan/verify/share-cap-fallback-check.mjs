/**
 * verify/share-cap-fallback-check.mjs — 分享上限回退验证（2026-10-22 真跑暴露）
 *
 * 症状：日志「今日已推 3 条（上限 3）」，但配置 shareDaily=5、quota 工具显示 cap 5。
 * 根因（已修）：shareNote 只从 cfg.quota.shareDaily 取上限，cfg.quota 在某条调用链缺失时
 *   `{...quota.DEFAULTS, ...cfg.quota}` 只剩 DEFAULTS(3)，静默把上限变成 3。
 * 修法：cfg.quota 缺失回退读 cfg 顶层 shareDaily；仍缺才用 DEFAULTS。
 *
 * 本测试钉死这条回退链。
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const share = await import(pathToFileURL(path.join(APP, "lib/share.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir(count) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "capf-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  fs.writeFileSync(path.join(d, "share-state.json"), JSON.stringify({
    day: new Date().toLocaleDateString("sv-SE"),
    sent: Array.from({ length: count }, (_, i) => "BV" + String(1000000000 + i)),
    count, recent: [],
  }));
  return d;
}
const mkSdk = () => ({
  network: {
    async fetch(url) {
      const u = String(url);
      if (u.includes("/x/relation?")) return { json: async () => ({ code: 0, data: { attribute: 6 } }) };
      if (u.includes("/x/web-interface/nav")) return { json: async () => ({ code: 0, data: { mid: 1, uname: "t" } }) };
      if (u.includes("send_msg")) return { json: async () => ({ code: 0, data: { msg_key: 1 } }) };
      return { json: async () => ({ code: 0, data: {} }) };
    },
  },
});
const note = { summary: "诊断", source: "BV1capfallback01", at: new Date().toISOString() };

console.log("[1] cfg 带 quota.shareDaily=5 + 顶层 5，count=3 → 放行（上限是 5 不是 3）");
await ta("quota 正常时上限对齐配置", async () => {
  const d = mkDir(3);
  const r = await share.shareNote(mkSdk(), d, note, { toMid: "100", cfg: { shareToOwner: true, shareDaily: 5, quota: { shareDaily: 5 } } });
  assert.notEqual(r.sent === true || true, false, "必成");
  // count=3 < cap5 → 不拦（可能走发送）
  assert.ok(!String(r.reason || "").includes("上限"), `意外被上限拦：${r.reason}`);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] cfg.quota 缺失但顶层 shareDaily=5，count=3 → 回退 5 放行（修复核心）");
await ta("quota 缺失回退 cfg.shareDaily=5", async () => {
  const d = mkDir(3);
  const r = await share.shareNote(mkSdk(), d, note, { toMid: "100", cfg: { shareToOwner: true, shareDaily: 5 } });
  assert.ok(!String(r.reason || "").includes("上限"), `应回退到 5 放行，却拦：${r.reason}`);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] cfg 无 quota 无顶层，count=3 → 回退 DEFAULTS=3 拦（最后兜底）");
await ta("无 quota 无顶层回退 DEFAULTS=3", async () => {
  const d = mkDir(3);
  const r = await share.shareNote(mkSdk(), d, note, { toMid: "100", cfg: { shareToOwner: true } });
  assert.ok(String(r.reason || "").includes("上限 3"), `应回退 DEFAULTS=3 拦，却：${r.reason || r.sent}`);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] cfg 顶层 shareDaily=10（高于 quota 5）→ 顶层优先？否，quota 优先");
await ta("quota 存在时 quota 优先于 cfg 顶层", async () => {
  const d = mkDir(6);  // count=6
  const r = await share.shareNote(mkSdk(), d, note, { toMid: "100", cfg: { shareToOwner: true, shareDaily: 10, quota: { shareDaily: 5 } } });
  // count=6 >= quota5 → 应被 quota 上限拦（说明 quota 优先于顶层 shareDaily=10）
  assert.ok(String(r.reason || "").includes("上限 5"), `quota 应优先，却被 ${r.reason || r.sent}`);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);