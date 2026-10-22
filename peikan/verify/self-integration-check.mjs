/**
 * verify/self-integration-check.mjs — self 层集成到 wake 的验证（P1）
 *
 * 确认：TOOLS 里有 bili_recall / bili_self_note；runTool 能调；
 *       brief 注入；接地后能真进 self.md。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const wake = await import(pathToFileURL(path.join(APP, "lib/wake.js")).href);
const store = await import(pathToFileURL(path.join(APP, "lib/store.js")).href);
const self = await import(pathToFileURL(path.join(APP, "lib/self.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "selfint-"));
  fs.writeFileSync(path.join(d, "identity.json"), JSON.stringify({ agentId: "a1" }));
  fs.writeFileSync(path.join(d, "persona.md"), "你是奥菲莉娅。");
  fs.mkdirSync(path.join(d, "notes"), { recursive: true });
  fs.writeFileSync(path.join(d, "notes", "index.json"), "[]");
  return d;
};

console.log("[1] TOOLS 声明里有 self 工具");
t("bili_recall 在 TOOLS", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('name: "bili_recall"');
  assert.ok(i > 0, "没声明 bili_recall");
});
t("bili_self_note 在 TOOLS", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('name: "bili_self_note"');
  assert.ok(i > 0, "没声明 bili_self_note");
});

console.log("\n[2] runTool 能真跑 recall/self_note");
await ta("bili_note → bili_self_note 沉淀 → bili_recall 读回", async () => {
  const d = mkDir();
  // 造凭据（recall 不需要，但 note 的元数据拉取会用到 network；这里给假网络）
  const sdk = {
    network: { async fetch() { return { json: async () => ({ code: 0, data: { item: [] } }) }; } },
  };
  const runner = wake.makeToolRunner(sdk, d, { round: "content" });

  // 1) 写一条笔记（summary 里含一句可沉淀的话）
  const noteOut = await runner("bili_note", { title: "一条线的背面", summary: "一整排人替一个被杀死的婴儿论证死了是解脱。", kind: "video" });
  assert.ok(String(noteOut).includes("已写入笔记"), noteOut);
  const noteId = String(noteOut).match(/已写入笔记 (n_[A-Za-z0-9_]+)/)?.[1];
  assert.ok(noteId, "拿不到笔记 id");

  // 2) 沉淀为自我认识（原样句子）
  const selfOut = await runner("bili_self_note", { noteId, sentence: "一整排人替一个被杀死的婴儿论证死了是解脱" });
  assert.ok(String(selfOut).includes("记下了"), selfOut);

  // 3) 读回自我认识
  const recallOut = await runner("bili_recall", { what: "self" });
  assert.ok(String(recallOut).includes("一整排人"), recallOut);

  // 4) self.md 已生成
  assert.ok(fs.existsSync(path.join(d, "self.md")), "self.md 没生成");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("自我认识注入 brief 出现", async () => {
  const d = mkDir();
  // 直接写一条进 self
  store.addNote(d, { title: "T", summary: "热评比正片更能说明问题。", kind: "video" });
  const note = store.listNotes(d, 10)[0];
  const r = self.select(d, { noteId: note.id, sentence: "热评比正片更能说明问题" });
  assert.equal(r.ok, true, r.reason);
  const b = self.brief(d, 7);
  assert.ok(b.includes("热评比正片更能说明问题"), "brief 没带句子");
  fs.rmSync(d, { recursive: true, force: true });
});

ta("wake 里 brief 注入段存在", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  assert.ok(src.includes("selfBrief"), "wake 没注入 self.brief");
  assert.ok(src.includes("self.brief"), "wake 没调 self.brief");
});

console.log("\n[3] 权限红线：工具表（wake TOOLS）不因 self 增加发布能力");
t("TOOLS 仍不含 bili_publish（self 不加权限）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf("const TOOLS = [");
  const j = src.indexOf("];", i);
  const block = src.slice(i, j);
  assert.ok(!block.includes('name: "bili_publish"'), "TOOLS 里出现 bili_publish");
});
t("bili_recall / bili_self_note 都不在「发布闸门」的判定里", () => {
  const gate = fs.readFileSync(path.join(APP, "lib/gate.js"), "utf8");
  assert.ok(!gate.includes("bili_self"), "gate 不该碰 self 工具");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);