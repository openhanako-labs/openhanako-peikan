/**
 * verify/store-cap-check.mjs — P2-3 笔记软护栏验证
 *
 * addNote 超过 MAX_NOTES(2000) 应裁剪最旧，保持 notes/index.json 有界。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const store = await import(pathToFileURL(path.join(APP, "lib/store.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const d = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));

console.log("[1] 超过上限裁剪最旧");
t("写入 2050 条后索引保持 2000 条，且保留的是最新的", () => {
  for (let i = 0; i < 2050; i++) {
    store.addNote(d, { title: `n${i}`, summary: `s${i}`, kind: "video" });
  }
  const p = path.join(d, "notes", "index.json");
  const all = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(all.length, 2000, `索引应为 2000 条，实际 ${all.length}`);
  // 应该保留的是最新（i 大）的
  assert.equal(all[all.length - 1].title, "n2049", "应保留最新的");
  assert.ok(!all.some((x) => x.title === "n0"), "最旧的应被裁掉");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 未超限不裁剪");
t("写入 5 条不裁剪", () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "cap2-"));
  for (let i = 0; i < 5; i++) store.addNote(d2, { title: `a${i}`, summary: "x" });
  const all = JSON.parse(fs.readFileSync(path.join(d2, "notes", "index.json"), "utf8"));
  assert.equal(all.length, 5);
  fs.rmSync(d2, { recursive: true, force: true });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);