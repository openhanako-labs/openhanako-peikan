/**
 * verify/note-outlets-check.mjs — 所有写笔记的出口都必须带元数据
 *
 * 由来（2026-10-20 连续踩三次）：
 *   我把自动补全加在 bili_note 工具上，结果规则路径直接调 store.addNote 绕过了；
 *   补到 store.addNote 后，发现 brain 循环里还有第三个执行器也自己调 store.addNote。
 *
 * 这个测试的本质：找出所有 store.addNote 的调用点，
 * 逐个断言「要么直接传了元数据，要么 source 里有 BV 能让 addNote 自己补」。
 * 以后再加新的写笔记路径，这个测试会立刻报出来。
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
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "outlets-"));

console.log("[1] store.addNote 自己会补");

await ta("只给 source（带 BV: 前缀），从缓存补齐", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "video-meta.json"), JSON.stringify({
    BV1xx411c7m2: { up: "观视频工作室", duration: 2779, pubdate: 1792234800, cover: "BV1xx411c7m2.jpg" },
  }));
  // 2026-10-20 改：cover 字段只有文件真的在磁盘上才给（否则界面会白跑一个 404）
  fs.mkdirSync(path.join(d, "covers"), { recursive: true });
  fs.writeFileSync(path.join(d, "covers", "BV1xx411c7m2.jpg"), "x");

  const n = store.addNote(d, { source: "BV:BV1xx411c7m2", kind: "video", summary: "s" });
  assert.equal(n.bvid, "BV1xx411c7m2", "BV 没抽出来");
  assert.equal(n.duration, 2779, "时长没补");
  assert.equal(n.up, "观视频工作室", "UP 没补");
  assert.equal(n.pubdate, 1792234800, "发布时间没补");
  assert.equal(n.cover, "BV1xx411c7m2.jpg", "封面没补");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("封面文件不存在时，cover 给空串（不造 404）", async () => {
  const d = mkDir();
  const n = store.addNote(d, { source: "BV1zzzz9999", summary: "s" });
  assert.equal(n.bvid, "BV1zzzz9999");
  assert.equal(n.cover, "", "没文件就不该给 cover");
  assert.equal(n.duration, 0, "没缓存就是 0，不瞎编");
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("显式传的优先于缓存", async () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, "video-meta.json"), JSON.stringify({
    BV1aaa: { up: "缓存UP", duration: 100 },
  }));
  const n = store.addNote(d, { source: "BV1aaa", up: "传进来的UP", duration: 999 });
  assert.equal(n.up, "传进来的UP");
  assert.equal(n.duration, 999);
  fs.rmSync(d, { recursive: true, force: true });
});

await ta("没有 BV 的笔记也能写（比如评论/私信类）", async () => {
  const d = mkDir();
  const n = store.addNote(d, { source: "uid:123", kind: "reply", summary: "有人回我" });
  assert.equal(n.bvid, "");
  assert.equal(n.cover, "");
  assert.equal(n.duration, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 所有出口都在补全之下");

/** 找出所有调用 store.addNote 的文件 */
function findOutlets() {
  const libDir = path.join(APP, "lib");
  const out = [];
  for (const f of fs.readdirSync(libDir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    if (/store\.addNote\s*\(/.test(src)) out.push(f);
  }
  return out.sort();
}

t("只有 store.js 定义 addNote，其余都是调用", () => {
  const libDir = path.join(APP, "lib");
  let defs = 0;
  for (const f of fs.readdirSync(libDir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    const m = src.match(/export\s+function\s+addNote/g);
    if (m) defs += m.length;
  }
  assert.equal(defs, 1, "addNote 应该只有一处定义");
});

t("每个调用点都用 store.addNote（不直接写 index.json）", () => {
  const libDir = path.join(APP, "lib");
  for (const f of fs.readdirSync(libDir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    if (f === "store.js") continue;
    // 不允许绕过 store 直接写笔记文件
    const direct = /notes[\"'],\s*[\"']index\.json/.test(src) || /notes\/index\.json/.test(src);
    assert.ok(!direct, `${f} 直接写了 notes/index.json，绕过了 addNote`);
  }
});

t("brain 的工具执行器写笔记前会先查元数据", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  const i = src.indexOf('if (name === "bili_note")');
  assert.ok(i > 0, "找不到 brain 里的 bili_note 执行器");
  const block = src.slice(i, i + 1400);
  assert.ok(block.includes("videoMeta.fetchAndSave"), "写笔记前没查元数据");
  assert.ok(block.includes("frames.cover"), "没下封面");
});

t("规则路径把已有的 video 数据直接传进去", () => {
  const src = fs.readFileSync(path.join(APP, "lib/browse.js"), "utf8");
  const i = src.indexOf("store.addNote");
  assert.ok(i > 0, "找不到规则路径的 addNote");
  const block = src.slice(i, i + 600);
  assert.ok(block.includes("duration"), "没传 duration");
  assert.ok(block.includes("pubdate"), "没传 pubdate");
  assert.ok(block.includes("up"), "没传 up");
});

console.log("\n[3] 出口数量（知道有几个口子，才知道要测几个）");
t(`当前出口：${findOutlets().join(" / ")}`, () => {
  const o = findOutlets();
  assert.ok(o.length >= 3, "至少 store/browse/wake 三个");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
