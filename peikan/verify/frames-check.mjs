/**
 * verify/frames-check.mjs — 抽帧模块验证
 *
 * 重点：沙箱里不能自己 stat 盘外 exe，也不能直接 child_process。
 * App 必须走宿主 `ctx.process.resolveExecutable`。
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const frames = await import(pathToFileURL(path.join(APP, "lib/frames.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const DATA = process.env.OPHELIA_DATA_DIR || path.join(os.homedir(), ".hanako", "app-data", "peikan");

console.log("[1] 宿主解析（沙箱里唯一正路）");
await ta("给宿主的候选只能是裸命令名（不能带 Windows 绝对路径）", async () => {
  const seen = [];
  const ctx = {
    process: {
      async resolveExecutable({ candidates }) {
        seen.push(...candidates);
        return { path: "C:\\fake\\ffmpeg.exe", size: 1, mtimeMs: 1 };
      },
    },
  };
  await frames.resolve(ctx);
  const winPaths = seen.filter((c) => /^[A-Za-z]:[/\\]/.test(c));
  assert.equal(winPaths.length, 0, `给宿主传了 Windows 绝对路径会被拒：${winPaths.join(", ")}`);
  assert.ok(seen.includes("ffmpeg"), "应该传裸命令名 ffmpeg");
});
await ta("有 process.resolveExecutable → 走宿主", async () => {
  const ctx = {
    process: {
      async resolveExecutable({ candidates }) {
        assert.ok(Array.isArray(candidates) && candidates.length > 0, "候选列表不能空");
        // 只对裸名字返回命中，模拟 PATH 里有 ffmpeg
        if (candidates.includes("ffmpeg")) {
          return { path: "C:\\fake\\ffmpeg.exe", size: 12345, mtimeMs: 1 };
        }
        return null;
      },
    },
  };
  const r = await frames.resolve(ctx);
  assert.equal(r.ok, true);
  assert.ok(String(r.via).startsWith("host"), `via=${r.via}`);
  assert.equal(r.path, "C:\\fake\\ffmpeg.exe");
});
await ta("PATH 没命中 → 逐个试绝对路径", async () => {
  const tried = [];
  const ctx = {
    process: {
      async resolveExecutable({ candidates }) {
        tried.push(candidates);
        // 只让绝对路径命中
        if (candidates.length === 1 && /^[A-Za-z]:\\/.test(candidates[0])) {
          return { path: candidates[0], size: 1, mtimeMs: 1 };
        }
        return null;
      },
    },
  };
  const r = await frames.resolve(ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.via, "host-abs");
  assert.ok(tried.some((c) => c.includes("ffmpeg")), "应该先试过裸名字");
});
await ta("宿主找不到 → 明确报错而不是静默", async () => {
  const ctx = { process: { async resolveExecutable() { return null; } } };
  const r = await frames.resolve(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.via, "host");
  assert.ok(r.error.includes("找不到") || r.error.includes("没找"), r.error);
  assert.ok(r.hint, "要给可操作的下一步");
});
await ta("宿主能力抛错 → 不炸，包成 error", async () => {
  const ctx = { process: { async resolveExecutable() { throw new Error("权限不足"); } } };
  const r = await frames.resolve(ctx);
  assert.equal(r.ok, false);
  assert.ok(String(r.hint || r.error).length > 0, "要给提示");
});
await ta("候选里带绝对路径也给名字（让宿主去 PATH 找）", async () => {
  const ctx = { process: { async resolveExecutable({ candidates }) {
    assert.ok(candidates.includes("ffmpeg"), "应该把裸名字也交给宿主");
    return { path: "x", size: 1, mtimeMs: 1 };
  } } };
  await frames.resolve(ctx);
});

console.log("\n[2] 本地兜底（开发环境）");
await ta("没有 process 能力 → 退回本地探测", async () => {
  const r = await frames.resolve({});
  assert.equal(r.via, "local");
  // 本机装了 ffmpeg，这里应该是 true；没装也该是 false 而非抛错
  assert.equal(typeof r.ok, "boolean");
});
t("ffmpegPath() 同步版仍可用（本机）", () => {
  const p = frames.ffmpegPath();
  if (p) assert.ok(p.endsWith("ffmpeg.exe") || p.endsWith("ffmpeg"));
});

console.log("\n[3] grab 参数校验（不联网就该返回）");
await ta("缺 bvid → 明确报错", async () => {
  const r = await frames.grab({}, DATA, { cid: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("bvid"));
});
await ta("缺 cid → 明确报错", async () => {
  const r = await frames.grab({}, DATA, { bvid: "BV1xx" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("cid"));
});
await ta("grab 会检查 ffmpeg 再取直链", async () => {
  // 宿主明确说找不到 → 应该在取直链之前就返回
  const sdk = {
    process: { async resolveExecutable() { return null; } },
    network: { async fetch() { throw new Error("不该联网"); } },
  };
  const r = await frames.grab(sdk, DATA, { bvid: "BV1xx", cid: 1 });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("ffmpeg") || String(r.error).includes("没找到"), r.error);
});

console.log("\n[4] 成本约束（都关系到会不会超时）");
t("默认 30 秒 / 2x2", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(src.includes(": 30;"), "默认时长被改了");
  assert.ok(src.includes(": 2;"), "默认 2x2 被改");
});
t("下载有 Range 上限，且低于宿主 8MB 硬顶", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(src.includes("MAX_BYTES"), "没有字节上限 → 会下整片，超时");
  assert.ok(src.includes("range: `bytes=0-${"), "Range 头没带上限");
  // 宿主 network.maxResponseBytes 默认 8MB，超了报 response exceeded 8388608 bytes
  const m = /opts\.maxBytes\) > 0 \? Number\(opts\.maxBytes\) : ([\d.]+) \* 1024 \* 1024/.exec(src);
  assert.ok(m, "找不到默认字节上限");
  const mb = Number(m[1]);
  assert.ok(mb < 8, `默认 ${mb}MB 超过了宿主 8MB 硬顶（会报 response exceeded）`);
});
t("默认时长要和字节上限匹配", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  const mb = Number(/opts\.maxBytes\) > 0 \? Number\(opts\.maxBytes\) : ([\d.]+) \* 1024 \* 1024/.exec(src)[1]);
  const sec = Number(/opts\.maxSeconds\) > 0 \? Number\(opts\.maxSeconds\) : (\d+)/.exec(src)[1]);
  // 约算：720P 每秒 ~0.25MB；给一倍余量，避免声称的时长超过能下的量
  const guessSec = mb / 0.25;
  assert.ok(sec <= guessSec * 1.2, `声称 ${sec} 秒，但 ${mb}MB 大概只够 ${Math.round(guessSec)} 秒`);
});
t("优先报真实覆盖时长（truncated 字段）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(src.includes("probeDuration"), "没探真实时长");
  assert.ok(src.includes("truncated"), "没标记是否被截断");
  assert.ok(src.includes("requestedSeconds"), "没区分「想要」和「实际」");
});
t("抽帧只调一次 ffmpeg", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  // 逐帧循环会重新 seek 解码 N 次 → 超时
  assert.ok(!/for\s*\(let i = 0; i < N/.test(src), "又回退到了逐帧循环（会超时）");
  assert.ok(src.includes("fps="), "没用 fps 滤镜一次抽完");
  assert.ok(src.includes("tile="), "没在同一次调用里拼图");
});
t("临时文件写到 dataDir，不用 os.tmpdir()", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  // 只看代码（去掉注释再查），注释里提到 os.tmpdir() 是解释历史坑
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!code.includes("os.tmpdir()"), "又用 os.tmpdir() 写文件了，沙箱会拒写");
  assert.ok(code.includes(".frames-tmp"), "应该在 dataDir 下建临时目录");
});
t("outDir 被限制在 dataDir 内", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(src.includes("function safeUnder"), "没有路径围栏");
  assert.ok(src.includes("safeUnder(dataDir"), "outDir 没走围栏");
});

console.log("\n[5] manifest 权限与主机");
t("声明 app/process.spawn", () => {
  const j = JSON.parse(fs.readFileSync(path.join(APP, "manifest.json"), "utf8"));
  assert.ok((j.capabilities || []).includes("app/process.spawn"),
    "没声明 app/process.spawn → 宿主不会给 process 能力");
});
t("放行字幕主机", () => {
  const j = JSON.parse(fs.readFileSync(path.join(APP, "manifest.json"), "utf8"));
  // 2026-10-23：白名单改成家族通配（`*.hdslb.com`）后，不再逐条列具体主机。
  // 断言改成「是否被覆盖」——比查字符串更严：以后谁把通配符删了也会红。
  const hosts = j.network.allowedHosts || [];
  const covered = (host) => hosts.includes(host) || hosts.some((h) => h.startsWith("*.") && host.endsWith(h.slice(1)));
  assert.ok(covered("aisubtitle.hdslb.com"), "字幕主机没被任何一条覆盖");
  assert.ok(covered("i0.hdslb.com"), "封面 CDN 没被任何一条覆盖");
});
t("放行视频直链主机（通配）", () => {
  const j = JSON.parse(fs.readFileSync(path.join(APP, "manifest.json"), "utf8"));
  assert.ok((j.network.allowedHosts || []).some((h) => h.includes("bilivideo")), "没有 bilivideo 主机");
});

console.log("\n[5.5] 直链选路：优先 B站 自家域名");
t("代码里有 bilivideo 判定与 backup 回退", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(src.includes("bilivideo"), "没判 bilivideo 域名");
  assert.ok(src.includes("backup_url"), "没用 backup_url 回退");
  assert.ok(src.includes("platform=html5"), "没试 html5（它常直接给自家域名）");
});

console.log("\n[6] 工具层必须把 ctx 传给 grab");
t("bili_debrief 传了 ctx", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tools.js"), "utf8");
  const i = src.indexOf("frames.grab(");
  assert.ok(i > 0, "没找到 frames.grab 调用");
  const block = src.slice(i, i + 260);
  assert.ok(block.includes("ctx"), "没把 ctx 传进 grab → 沙箱里会找不到 ffmpeg");
});
t("宿主候选与本地探测是两套", () => {
  const src = fs.readFileSync(path.join(APP, "lib/frames.js"), "utf8");
  assert.ok(src.includes("export function candidates"), "缺给宿主的候选");
  assert.ok(src.includes("export function localCandidates"), "缺本地候选");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
