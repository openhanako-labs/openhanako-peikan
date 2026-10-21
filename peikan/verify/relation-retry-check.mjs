/**
 * verify/relation-retry-check.mjs — 「写完回读」时序修复验证
 *
 * 复现：relation/modify 成功后，x/relation 第一次仍返回旧值，
 *       隔一拍才变新。旧的 follow 实现读一次就下结论 → 误报「未关注」。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const social = await import(pathToFileURL(path.join(APP, "lib/social.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
  fs.writeFileSync(path.join(d, "credentials.json"), JSON.stringify({ sessdata: "S", bili_jct: "J", buvid3: "B" }));
  return d;
}

/**
 * 假 sdk：模拟「写完第一次查还是旧值」
 * @param staleReads 前几次 relation 查询返回旧值 0，之后返回 newAttr
 */
function fakeSdk({ staleReads = 2, newAttr = 2 } = {}) {
  let reads = 0;
  return {
    network: {
      async fetch(url) {
        const u = String(url);
        if (u.includes("/x/relation?")) {
          reads += 1;
          const attr = reads <= staleReads ? 0 : newAttr;
          return { json: async () => ({ code: 0, data: { attribute: attr } }) };
        }
        if (u.includes("relation/modify")) {
          return { json: async () => ({ code: 0, data: {} }) };
        }
        if (u.includes("/x/web-interface/nav")) {
          return { json: async () => ({ code: 0, data: { mid: 111, uname: "我" } }) };
        }
        return { json: async () => ({ code: 0, data: {} }) };
      },
    },
  };
}

console.log("[1] 重试能等到新值");
await ta("前 2 次旧值，第 3 次变 2 → settled=true, attribute=2", async () => {
  const d = mkDir();
  const r = await social.follow(fakeSdk({ staleReads: 2, newAttr: 2 }), d, { mid: "222", live: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.attribute, 2, `得到 attribute=${r.attribute}`);
  assert.equal(r.settled, true, "应该标记已完成");
  assert.ok(r.waitedMs > 0, "应该等过");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("直接变 6（对方已回关）也能识别", async () => {
  const d = mkDir();
  const r = await social.follow(fakeSdk({ staleReads: 1, newAttr: 6 }), d, { mid: "222", live: true });
  assert.equal(r.attribute, 6);
  assert.equal(r.settled, true);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 一直不刷新时如实报告");
await ta("永远旧值 → settled=false 且给提示", async () => {
  const d = mkDir();
  const r = await social.follow(fakeSdk({ staleReads: 999, newAttr: 2 }), d, { mid: "222", live: true });
  assert.equal(r.ok, true, "接口本身成功");
  assert.equal(r.settled, false, "应标记未确认");
  assert.ok(String(r.note || "").includes("尚未刷新"), `note=${r.note}`);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 不再误报「未关注」");
await ta("旧实现会误报 0，新实现拿到真值", async () => {
  const d = mkDir();
  const r = await social.follow(fakeSdk({ staleReads: 1, newAttr: 2 }), d, { mid: "222", live: true });
  // 关键的断言：after 不该是「未关注」
  assert.notEqual(r.after, "未关注", `仍然误报：${r.after}`);
  assert.equal(r.after, "已关注（对方未回关）");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
