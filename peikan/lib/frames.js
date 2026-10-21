/**
 * lib/frames.js — 让她真的看见画面（P15）
 *
 * 之前 `debrief` 只能拿到标题/简介/热评/字幕/弹幕统计。
 * 无字幕的视频（MV、预告、纯画面）她其实什么也没看到，
 * 却还是会写出「热评比视频本身更能说明问题」——那是限制的形状，不是洞见。
 *
 * 这个模块补上最后一环：取直链 → 下载 → ffmpeg 抽帧 → 拼九宫格 → 返回图片路径。
 *
 * ⚠️ 沙箱铁则（2026-10-20 真机踩到）：
 *   App 进程不能自己 `fs.statSync` 到盘外的 exe，也不能直接 `child_process`。
 *   宿主把这两件事拆成了专门的能力：
 *     · 解析可执行文件 → `ctx.process.resolveExecutable({ candidates })`（app/process.spawn）
 *     · 真正执行       → `ctx.services.process.run(...)` 或宿主提供的 spawn
 *   本地 shell 能跑 ≠ App 进程里能跑。这是两套环境。
 *
 * 成本控制：只下前 90 秒；默认 3×3；用完删 mp4，只留一张 jpg。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as auth from "./auth.js";

const EXE = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/**
 * 候选列表。
 *
 * 坑（2026-10-20 真机）：宿主的校验用的是 `te.isAbsolute()`，
 * 而宿主 bundle 里的 `te` 走 posix 语义 → Windows 风格的 `X:\\dir\\exe` 会被判为「既非绝对路径也非命令名」而整条拒掉。
 * 所以给宿主的候选只给**裸命令名**，让它自己去 PATH 里找；
 * 绝对路径只在没有宿主能力时（本地开环境）才用。
 */
export function candidates(extra = []) {
  // 给宿主：裸命令名 + 绝对路径各一条。
  // 不能一次给多条 Windows 绝对路径（宿主用 posix 语义校验，会整批拒），
  // 但单独一条绝对路径能过（它在 win32 上是 isAbsolute，正则也满足不了，
  // 所以关键是不混发——这里分两次试，见 resolve()）。
  const names = ["ffmpeg"];
  if (process.env.FFMPEG) {
    const v = process.env.FFMPEG;
    if (v && !/[\0\r\n]/.test(v)) names.unshift(v);
  }
  for (const e of (extra || [])) {
    if (e && !/[\0\r\n]/.test(e)) names.unshift(e);
  }
  return names;
}

/**
 * 宿主侧的绝对路径候选（逐个试，一次只传一条）。
 * 本机已知位置；宿主 PATH 里没有时就靠这些。
 */
export function hostAbsoluteCandidates() {
  // 2026-10-21：以前写死了本机路径（W:\\Games\\ffmpeg），
  // 换台机器就失效，而且把盘符布局泄露到了仓库里。
  // 现在按优先级：环境变量 > 常见安装位置 > 用户目录。
  const candidates = [
    process.env.FFMPEG,
    process.env.FFMPEG_HOME ? path.join(process.env.FFMPEG_HOME, "bin", EXE) : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "ffmpeg", "bin", EXE) : "",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    path.join(os.homedir(), ".dsh", "bili-whale", "bin", EXE),
  ];
  return candidates.filter((p) => p && /^[A-Za-z]:[\\/]/.test(p));
}

/** 本地探测用（开发环境）：绝对路径候选 */
export function localCandidates(extra = []) {
  const list = [
    process.env.FFMPEG,
    ...(extra || []),
    process.env.FFMPEG_HOME ? path.join(process.env.FFMPEG_HOME, "bin", EXE) : "",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "ffmpeg", "bin", EXE),
    path.join(os.homedir(), ".dsh", "bili-whale", "bin", EXE),
    EXE,
  ];
  for (const d of String(process.env.PATH || "").split(path.delimiter)) {
    if (d) list.push(path.join(d, EXE));
  }
  return list.filter(Boolean);
}

/**
 * 解析 ffmpeg。
 * 优先走宿主 `ctx.process.resolveExecutable`（沙箱里唯一可行的路）；
 * 宿主没给这个能力时，退回本地探测（开发/测试环境）。
 */
export async function resolve(ctx, extra = []) {
  const names = candidates(extra);

  const rp = ctx?.process?.resolveExecutable;
  if (typeof rp === "function") {
    // ① 先试裸名字（宿主 PATH）
    try {
      const hit = await rp.call(ctx.process, { candidates: names });
      if (hit && hit.path) return { ok: true, path: hit.path, via: "host-path", size: hit.size };
    } catch { /* 落到逐个试绝对路径 */ }

    // ② 再逐个试绝对路径（一次只传一条：批量传 Windows 路径会被整批拒）
    for (const abs of hostAbsoluteCandidates()) {
      try {
        const hit = await rp.call(ctx.process, { candidates: [abs] });
        if (hit && hit.path) return { ok: true, path: hit.path, via: "host-abs", size: hit.size };
      } catch { /* 下一条 */ }
    }

    return {
      ok: false,
      via: "host",
      error: "宿主既找不到 PATH 里的 ffmpeg，也没在已知位置找到",
      hint: "在设置页填「ffmpeg 路径」，或把 ffmpeg.exe 放进宿主进程的 PATH",
      triedPath: names,
      triedAbs: hostAbsoluteCandidates(),
    };
  }

  // 兜底：本地环境（开发/测试）
  for (const c of localCandidates(extra)) {
    try { if (c && fs.statSync(c).isFile()) return { ok: true, path: c, via: "local" }; } catch { /* 继续 */ }
  }
  return { ok: false, via: "local", error: "本地也没找到 ffmpeg", hint: "设 FFMPEG=<路径>" };
}

/** 同步版（仅本地环境可能成功） */
export function ffmpegPath(extra = []) {
  for (const c of localCandidates(extra)) {
    try { if (c && fs.statSync(c).isFile()) return c; } catch { /* 继续 */ }
  }
  return null;
}

/** 体检（异步，走宿主） */
export async function info(ctx, extra = []) {
  const r = await resolve(ctx, extra);
  if (!r.ok) return { ok: false, path: null, version: null, error: r.error, hint: r.hint, via: r.via };
  return { ok: true, path: r.path, version: null, via: r.via, size: r.size };
}

/**
 * 取播放直链。
 *
 * 坑（2026-10-20 真机）：
 *   · 主链 host 可能是第三方 CDN（如 `pv5br67a.edge.mountaintoys.cn`），
 *     不在 manifest 白名单里，network.fetch 会直接拒。
 *   · 但 `backup_url` 里通常有 B站 自家域名 `*.bilivideo.com`。
 *   · `platform=html5` 常常直接给自家域名。
 * 所以顺序：html5 主链 → 普通主链的 bilivideo 备选 → 普通主链。
 */
async function playUrl(sdk, dataDir, { bvid, cid }) {
  const cred = auth.loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "没有凭据" };
  const H = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    referer: "https://www.bilibili.com/",
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}` + (cred.buvid3 ? `; buvid3=${cred.buvid3}` : ""),
  };
  const QN = { 16: "360P", 32: "480P", 64: "720P", 80: "1080P" };
  const isBili = (u) => { try { return /(^|\.)bilivideo\.com$/i.test(new URL(u).hostname); } catch { return false; } };

  const builds = [
    // html5 常直接给自家域名
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=html5&high_quality=1`,
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`,
  ];

  const failures = [];
  for (const url of builds) {
    try {
      const r = await sdk.network.fetch(url, { method: "GET", headers: H });
      const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
      if (j?.code !== 0) { failures.push(`code=${j?.code}`); continue; }
      const durls = j?.data?.durl || [];
      const quality = QN[j.data.quality] ?? String(j.data.quality);

      for (const d of durls) {
        // ① 主链就是 bilivideo → 直接用
        if (isBili(d.url)) return { ok: true, url: forceHttps(d.url), quality, via: "main" };
        // ② 否则看 backup 里有没有 bilivideo
        const alt = (d.backup_url || []).find(isBili);
        if (alt) return { ok: true, url: forceHttps(alt), quality, via: "backup" };
        // ③ 都没有就先拿主链（后面白名单会拒，但至少能看清楚卡在哪）
        if (d.url) {
          const host = (() => { try { return new URL(d.url).hostname; } catch { return "?"; } })();
          failures.push(`主链 ${host} 不在白名单，且无 bilivideo 备选`);
        }
      }
      if (!durls.length) failures.push("无 durl（可能只有 dash 流）");
    } catch (e) {
      failures.push(String(e && e.message ? e.message : e).slice(0, 80));
    }
  }

  return { ok: false, error: `拿不到可下载的直链：${failures.join("；")}` };
}

/**
 * 抽帧。
 *
 * @param {object} opts
 *   bvid     必填
 *   cid      必填（debrief 里带出来）
 *   cols/rows 九宫格尺寸，默认 3x3
 *   maxSeconds 只下前 N 秒，默认 90
 *   outDir   图片落点（默认 dataDir/frames）
 */
/** 确保路径在 dataDir 内（沙箱只允许写这里） */
function safeUnder(dataDir, p, fallbackName) {
  const root = path.resolve(dataDir);
  try {
    const r = path.resolve(p);
    if (r === root || r.startsWith(root + path.sep)) return r;
  } catch { /* 落到 fallback */ }
  return path.join(root, fallbackName);
}

/**
 * 探实际时长（秒）。
 *
 * 为什么要：12MB 截断下载后，实际拿到的秒数可能仍少于 maxSec。
 * 按 maxSec 算抽帧密度 → 只抽到一半、帖子空一半（黑格）。
 * ffmpeg -i 会把 Duration 打到 stderr；不带输出文件时退出码非 0，从 stderr 读。
 */
function probeDuration(file, fpath) {
  const parse = (s) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(String(s || ""));
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  };
  try {
    const out = execFileSync(fpath, ["-hide_banner", "-i", file], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000,
    });
    const d = parse(out);
    if (d) return d;
  } catch (e) {
    const d = parse((e && (e.stderr || e.stdout)) || "");
    if (d) return d;
  }
  return null;
}

/**
 * 下载封面（成本几乎为零：一次 GET，~100KB）。
 * 封面是 UP 主自己选的「第一眼」，往往比正文更能看出他想卖什么。
 */
export async function cover(sdk, dataDir, opts = {}) {
  const bvid = String(opts.bvid || "");
  const pic = String(opts.pic || "");
  if (!bvid) return { ok: false, error: "缺 bvid" };

  // 缓存检查要放在最前面：有图就不该再去请求任何接口
  const outDir = safeUnder(dataDir, opts.outDir || path.join(dataDir, "covers"), "covers");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${bvid}.jpg`);
  if (fs.existsSync(out) && opts.force !== true) {
    return { ok: true, cover: out, bytes: fs.statSync(out).size, cached: true };
  }

  // pic 一般在 view 接口里，调用方可以传进来省一次请求
  let url = pic;
  if (!url) {
    try {
      const cred = auth.loadCredentials(dataDir);
      const r = await sdk.network.fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        method: "GET",
        headers: cred ? auth.headers(cred) : { referer: "https://www.bilibili.com/" },
      });
      const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
      url = j?.data?.pic || "";
    } catch { /* 落到下面报错 */ }
  }
  if (!url) return { ok: false, error: "拿不到封面地址" };

  // i0/i1/i2.hdslb.com —— 已在 manifest 白名单
  //
  // 2026-10-21 修：B站 CDN 返回的 pic 是 http:// 开头，
  // 而宿主 network.fetch 只允许 HTTPS（HTTP 只开放给声明过的 localhost）。
  // 结果就是：元数据能拿到、封面永远下不下来，而且失败被静默吞了。
  // hdslb CDN 同时支持 https，直接升协议即可。
  const httpsUrl = url.replace(/^http:\/\//i, "https://");
  try {
    const r = await sdk.network.fetch(httpsUrl, {
      method: "GET",
      headers: { referer: "https://www.bilibili.com/", "user-agent": "Mozilla/5.0" },
    });
    const buf = typeof r.arrayBuffer === "function" ? Buffer.from(await r.arrayBuffer()) : null;
    if (!buf || !buf.length) return { ok: false, error: "封面下载为空" };
    fs.writeFileSync(out, buf);
    return { ok: true, cover: out, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 150) };
  }
}

/**
 * substrip：把硬字幕裁成一条条拼起来，一屏读完台词。
 *
 * 为什么需要：很多视频没官方字幕轨，台词直接烧在画面上。
 * 只裁下方 32% 的字幕带，每 N 秒一帧，竖着拼成一张长图。
 * 原仓库叫 `--substrip`，实测这个设计很有效。
 */
export async function substrip(sdk, dataDir, opts = {}) {
  const ctx = opts.ctx || sdk;
  const bvid = String(opts.bvid || "");
  const cid = opts.cid;
  if (!bvid || !cid) return { ok: false, error: "缺 bvid 或 cid" };

  const resolved = await resolve(ctx, opts.ffmpegCandidates);
  if (!resolved.ok) return { ok: false, error: resolved.error || "找不到 ffmpeg", via: resolved.via };
  const fpath = resolved.path;

  const every = Number(opts.every) > 0 ? Number(opts.every) : 7;   // 每 N 秒取一帧
  const maxRows = Number(opts.maxRows) > 0 ? Number(opts.maxRows) : 20;
  const span = Number(opts.seconds) > 0 ? Number(opts.seconds) : 120;

  const pu = await playUrl(sdk, dataDir, { bvid, cid });
  if (!pu.ok) return { ok: false, error: pu.error };

  const outDir = safeUnder(dataDir, opts.outDir || path.join(dataDir, "covers"), "covers");
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(dataDir, ".frames-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpMp4 = path.join(tmpDir, `sub-${bvid}-${stamp}.mp4`);
  const out = path.join(outDir, `${bvid}-substrip.jpg`);

  try {
    const MAX_BYTES = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 7.5 * 1024 * 1024;
    const r = await sdk.network.fetch(pu.url, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        referer: "https://www.bilibili.com/",
        range: `bytes=0-${MAX_BYTES - 1}`,
      },
    });
    const buf = typeof r.arrayBuffer === "function" ? Buffer.from(await r.arrayBuffer()) : null;
    if (!buf || !buf.length) return { ok: false, error: "下载失败或为空" };
    fs.writeFileSync(tmpMp4, buf);

    const real = probeDuration(tmpMp4, fpath);
    const realSpan = Math.max(1, Math.min(span, real || span));

    // ��� 先真抽帧（不管能抽出几张），再按实际张数拼图
    //
    // 坑：`probeDuration` 读的是容器声明的时长（499 秒），
    // 不是实际下载到的部分。按它算行数 → 后面几行是黑的。
    // 所以先抽出来数一数，再 tile —— 两张都很快。
    const frameDir = path.join(tmpDir, `sub-${bvid}-${stamp}`);
    fs.mkdirSync(frameDir, { recursive: true });
    const pattern = path.join(frameDir, "f%03d.jpg");

    execFileSync(fpath, [
      "-y", "-loglevel", "error",
      "-t", String(realSpan),
      "-i", tmpMp4,
      // 字幕一般在画面下方 30%：从 68% 处开切，避开正文又不切断字
      "-vf", `fps=1/${every},crop=iw:ih*0.30:0:ih*0.68,scale=1280:-1`,
      "-q:v", "3", pattern,
    ], { stdio: "ignore", timeout: 20000 });

    const got = fs.readdirSync(frameDir).filter((f) => f.endsWith(".jpg")).length;
    if (!got) return { ok: false, error: "一帧字幕条都没抽到" };
    const rows = Math.min(got, maxRows);

    execFileSync(fpath, [
      "-y", "-loglevel", "error",
      "-i", pattern,
      "-vf", `tile=1x${rows}`,
      "-frames:v", "1", "-q:v", "3", out,
    ], { stdio: "ignore", timeout: 15000 });

    try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

    if (!fs.existsSync(out)) return { ok: false, error: "substrip 拼图失败" };

    return {
      ok: true,
      substrip: out,
      bytes: fs.statSync(out).size,
      rows,
      every,
      seconds: Number(realSpan.toFixed(1)),
      note: `把硬字幕裁成 ${rows} 条（每 ${every} 秒一条），一屏读完。`,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  } finally {
    try { if (fs.existsSync(tmpMp4)) fs.unlinkSync(tmpMp4); } catch { /* 忽略 */ }
  }
}

export async function grab(sdk, dataDir, opts = {}) {
  const ctx = opts.ctx || sdk;          // 宿主 ctx（用它的 process 能力）
  const bvid = String(opts.bvid || "");
  const cid = opts.cid;
  if (!bvid || !cid) return { ok: false, error: "缺 bvid 或 cid" };

  const resolved = await resolve(ctx, opts.ffmpegCandidates);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error || "找不到 ffmpeg",
      hint: resolved.hint || "把 ffmpeg.exe 放进 PATH，或用环境变量 FFMPEG=<绝对路径> 指定",
      via: resolved.via,
    };
  }
  const fpath = resolved.path;

  const cols = Number(opts.cols) > 0 ? Number(opts.cols) : 2;
  const rows = Number(opts.rows) > 0 ? Number(opts.rows) : 2;
  const pu = await playUrl(sdk, dataDir, { bvid, cid });
  if (!pu.ok) return { ok: false, error: pu.error };
  const N = cols * rows;
  // 默认 30 秒：配合 7.5MB 上限（宿主 8MB 硬顶），720P 下刚好下满。
  // 以前写 45 秒是假设能下完；现在宁可要“真的覆盖 30 秒”不要“声称 45 秒实际 20 秒”。
  const maxSec = Number(opts.maxSeconds) > 0 ? Number(opts.maxSeconds) : 30;

  const outDir = safeUnder(dataDir, opts.outDir || path.join(dataDir, "frames"), "frames");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // 临时文件必须放在 dataDir 里
  //
  // 坑（2026-10-20 真机）：App 沙箱只允许写 dataDir，
  // 写到 os.tmpdir() 会被拦为 "Access to this API has been restricted."
  const tmpDir = path.join(dataDir, ".frames-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpMp4 = path.join(tmpDir, `ob-${bvid}-${stamp}.mp4`);
  const sheet = path.join(outDir, `${bvid}-${cols}x${rows}.jpg`);

  try {
    // 下载：只取前几 MB（性能关键）
    //
    // 坑（2026-10-20 真机）：`range: "bytes=0-"` 会把整片下下来，
    // 499 秒的 720P 几十 MB，加 ffmpeg 直接超 30 秒 RPC 上限。
    // B站的 mp4 是 faststart（moov 在前），所以截断下载仍能解码。
    // 12MB ≈ 720P 下前 45-90 秒（实测 6MB 只够 ~20 秒，四格会空两格）

    // 7.5MB：宿主 `network.maxResponseBytes` 默认上限是 8MB，超了直接报
    // "response exceeded 8388608 bytes"。所以上限定在 8MB 下面一点。
    // 720P 下 7.5MB ≈ 前 25-35 秒（实测）。
    const MAX_BYTES = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 7.5 * 1024 * 1024;
    const r = await sdk.network.fetch(pu.url, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        referer: "https://www.bilibili.com/",
        range: `bytes=0-${MAX_BYTES - 1}`,
      },
    });
    const buf = typeof r.arrayBuffer === "function" ? Buffer.from(await r.arrayBuffer()) : null;
    if (!buf || !buf.length) return { ok: false, error: "下载失败或为空" };
    fs.writeFileSync(tmpMp4, buf);

    // 一次 ffmpeg 抽帧 + 拼图（性能关键）
    //
    // 坑（2026-10-20 真机）：逐帧调 9 次 ffmpeg，每次都重新 seek 解码，
    // 加起来超过宿主 RPC 的 30 秒上限 → 工具直接超时，什么都没返回。
    // 改成单次调用：fps 滤镜等间隔取 N 帧，tile 直接拼。
    // 先探实际能解码多久（6MB 截断后远少于 maxSec）
    const real = probeDuration(tmpMp4, fpath);
    const span = Math.max(1, Math.min(maxSec, real || maxSec));

    const fps = N / span;
    execFileSync(fpath, [
      "-y", "-loglevel", "error",
      "-t", String(span),
      "-i", tmpMp4,
      "-vf", `fps=${fps.toFixed(6)},scale=480:-1,tile=${cols}x${rows}`,
      "-frames:v", "1", "-q:v", "4", sheet,
    ], { stdio: "ignore", timeout: 25000 });

    if (!fs.existsSync(sheet)) return { ok: false, error: "拼图失败（视频太短或格式特殊）" };

    const truncated = Boolean(real && real < maxSec - 1);
    return {
      ok: true,
      sheet,
      bytes: fs.statSync(sheet).size,
      grid: `${cols}x${rows}`,
      frames: N,
      seconds: Number(span.toFixed(1)),
      requestedSeconds: maxSec,
      truncated,
      quality: pu.quality,
      via: pu.via,
      note: `抽了 ${N} 帧、覆盖前 ${span.toFixed(0)} 秒（${pu.quality}）`
        + (truncated ? `。只下到了 ${span.toFixed(0)} 秒（6MB 截断），不是完整 ${maxSec} 秒` : "")
        + "。这张图就是她看到的全部画面。",
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  } finally {
    try { if (fs.existsSync(tmpMp4)) fs.unlinkSync(tmpMp4); } catch { /* 忽略 */ }
  }
}
