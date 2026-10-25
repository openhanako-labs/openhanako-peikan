/**
 * lib/client.js — B站 请求层（P2：真实摄取）
 *
 * 立场：读用她自己的号（推荐流才是个性化的），auth 复用 lib/auth.js。
 * 只读：feed / 视频信息 / 评论。发布仍为桩，等 P5。
 *
 * 已知坑（来自 intake SKILL.md）：
 *   · 评论接口 /x/v2/reply/wbi/main 带 buvid3 会被砍回 3 条 → 必须 omitBuvid3。
 *   · 长视频字幕要 Whisper 兜底，本层不做（交给 agent 侧 intake）。
 */

import { signedRequest, loadCredentials, fetchNav } from "./auth.js";
import * as danmaku from "./danmaku.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const API = "https://api.bilibili.com";
const API_VC = "https://api.vc.bilibili.com";

/**
 * 推荐流（首页）。
 * 需要登录态才个性化；未登录会返回泛内容。
 * @returns {Promise<{ok:boolean, items:Array, note?:string}>}
 */
export async function feed(sdk, dataDir, { limit = 10 } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, items: [], note: "未配置凭据，推荐流不可用" };

  try {
    // 首页推荐：x/web-interface/wbi/index/top/feed/rcmd
    const json = await signedRequest(
      sdk, dataDir,
      `${API}/x/web-interface/wbi/index/top/feed/rcmd`,
      { ps: Math.min(Math.max(limit, 1), 30), fresh_type: 3, feed_version: "V8" }
    );

    if (json?.code !== 0) {
      return { ok: false, items: [], note: `rcmd code=${json?.code} ${json?.message || ""}` };
    }

    const raw = json?.data?.item || [];
    const items = raw.slice(0, limit).map((it) => ({
      bvid: it.bvid || "",
      aid: it.id || it.aid || 0,
      title: it.title || "",
      up: it.owner?.name || "",
      mid: it.owner?.mid || 0,
      duration: it.duration || 0,
      view: it.stat?.view ?? 0,
      danmaku: it.stat?.danmaku ?? 0,
      pubdate: it.pubdate || 0,
      desc: (it.desc || "").slice(0, 200),
    })).filter((x) => x.bvid);

    return { ok: true, items, note: `个性化推荐 ${items.length} 条` };
  } catch (e) {
    return { ok: false, items: [], note: `请求失败：${e && e.message ? e.message : e}` };
  }
}

/**
 * 搜索（关键词）。
 */
export async function search(sdk, dataDir, { keyword = "", limit = 10 } = {}) {
  if (!keyword) return { ok: false, items: [], note: "缺少 keyword" };
  try {
    const json = await signedRequest(
      sdk, dataDir,
      `${API}/x/web-interface/wbi/search/type`,
      { search_type: "video", keyword, page: 1, page_size: Math.min(Math.max(limit, 1), 30) }
    );
    if (json?.code !== 0) {
      return { ok: false, items: [], note: `search code=${json?.code} ${json?.message || ""}` };
    }
    const raw = json?.data?.result || [];
    const items = raw.slice(0, limit).map((it) => ({
      bvid: it.bvid || "",
      title: (it.title || "").replace(/<[^>]+>/g, ""),
      up: it.author || "",
      mid: it.mid || 0,
      duration: it.duration || "",
      view: it.play ?? 0,
      danmaku: it.video_review ?? 0,
      pubdate: it.pubdate || 0,
      desc: (it.description || "").slice(0, 200),
    })).filter((x) => x.bvid);
    return { ok: true, items, note: `搜索「${keyword}」${items.length} 条` };
  } catch (e) {
    return { ok: false, items: [], note: `请求失败：${e && e.message ? e.message : e}` };
  }
}

/**
 * 视频详情（含分P、cid）。
 */
export async function videoInfo(sdk, dataDir, { bvid = "" } = {}) {
  if (!bvid) return { ok: false, note: "缺少 bvid" };
  try {
    const json = await signedRequest(sdk, dataDir, `${API}/x/web-interface/view`, { bvid });
    if (json?.code !== 0) return { ok: false, note: `view code=${json?.code}` };
    const d = json.data || {};
    return {
      ok: true,
      video: {
        bvid: d.bvid,
        aid: d.aid,
        cid: d.cid,
        title: d.title,
        desc: d.desc,
        up: d.owner?.name,
        mid: d.owner?.mid,
        duration: d.duration,
        pubdate: d.pubdate,
        pic: d.pic,          // 封面地址，frames.cover 用它省一次请求
        view: d.stat?.view,
        danmaku: d.stat?.danmaku,
        reply: d.stat?.reply,
        like: d.stat?.like,
        tags: (d.tags || []).map((t) => t.tag_name),
      },
    };
  } catch (e) {
    return { ok: false, note: `请求失败：${e && e.message ? e.message : e}` };
  }
}

/**
 * 评论（一级）。⚠️ 必须 omitBuvid3，否则被砍回 3 条。
 */
export async function comments(sdk, dataDir, { aid = 0, bvid = "", limit = 20 } = {}) {
  if (!aid && !bvid) return { ok: false, items: [], note: "缺少 aid 或 bvid" };
  try {
    let oid = aid;
    let targetBv = bvid;
    if (!oid && bvid) {
      const info = await videoInfo(sdk, dataDir, { bvid });
      if (info.ok) { oid = info.video.aid; targetBv = info.video.bvid; }
    }
    if (!oid) return { ok: false, items: [], note: "拿不到 aid" };

    const json = await signedRequest(
      sdk, dataDir,
      `${API}/x/v2/reply/wbi/main`,
      { oid, type: 1, mode: 3, plat: 1, ps: Math.min(Math.max(limit, 1), 49), pn: 1 },
      {},
      { omitBuvid3: true }
    );

    if (json?.code !== 0) {
      return { ok: false, items: [], note: `reply code=${json?.code} ${json?.message || ""}` };
    }

    const raw = json?.data?.replies || [];
    const items = raw.slice(0, limit).map((r) => ({
      rpid: r.rpid_str || r.rpid,
      user: r.member?.uname || "",
      mid: r.member?.mid || r.mid || 0,
      content: (r.content?.message || "").slice(0, 500),
      like: r.like ?? 0,
      ctime: r.ctime || 0,
      replyCount: r.rcount ?? 0,
    }));

    return { ok: true, items, note: `热评 ${items.length} 条（buvid3 已摘除）`, oid, bvid: targetBv };
  } catch (e) {
    return { ok: false, items: [], note: `请求失败：${e && e.message ? e.message : e}` };
  }
}

/**
 * 字幕（P4.1）。
 * ⚠️ 两个已知坑：
 *   1. subtitle_url 可能是 // 开头的协议相对 URL，要补 https:
 *   2. body[].to 不能累加成时长（实测会算出 7225 秒而视频只有 267 秒）—— 用 from 的最大值
 */
export async function subtitles(sdk, dataDir, { aid = 0, cid = 0 } = {}) {
  if (!aid || !cid) return { ok: false, text: "", note: "缺 aid/cid" };
  try {
    const json = await signedRequest(
      sdk, dataDir,
      `${API}/x/player/wbi/v2`,
      { aid, cid }
    );
    if (json?.code !== 0) return { ok: false, text: "", note: `player code=${json?.code}` };

    const tracks = json?.data?.subtitle?.subtitles || [];
    if (!tracks.length) return { ok: false, text: "", note: "没有字幕轨" };

    // 优先中文
    const pick = tracks.find((t) => /zh|ai-zh/i.test(t.lan || "")) || tracks[0];
    let url = String(pick.subtitle_url || "");
    if (!url) return { ok: false, text: "", note: "字幕轨无 url" };
    if (url.startsWith("//")) url = "https:" + url;

    const fetchImpl = sdk.network.fetch.bind(sdk.network);
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" },
    });
    const body = typeof res.json === "function" ? await res.json() : JSON.parse(String(res));
    const lines = Array.isArray(body?.body) ? body.body : [];
    if (!lines.length) return { ok: false, text: "", note: "字幕体为空" };

    const text = lines.map((x) => String(x.content || "")).join(" ").replace(/♪/g, "").replace(/\s+/g, " ").trim();
    const lastFrom = Math.max(...lines.map((x) => Number(x.from) || 0));
    return {
      ok: true,
      text,
      lines: lines.length,
      duration: lastFrom,
      lang: pick.lan || "",
      note: `${pick.lan || "?"} 字幕 ${lines.length} 条 / ${Math.round(lastFrom)} 秒`,
    };
  } catch (e) {
    return { ok: false, text: "", note: `字幕失败：${e && e.message ? e.message : e}` };
  }
}

/**
 * 小工具：跑一个子进程，收 stdout/stderr。
 */
function runProcess(cmd, args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const ch = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ch.kill("SIGKILL"); } catch { /* 忽略 */ }
      resolve({ ok: false, code: -1, out, err: err + " [超时]" });
    }, timeoutMs);
    ch.stdout.on("data", (b) => { out += String(b); });
    ch.stderr.on("data", (b) => { err += String(b); });
    ch.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -2, out, err: String(e && e.message ? e.message : e) });
    });
    ch.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out, err });
    });
  });
}

/**
 * 音轨转写（无字幕时的兜底，2026-10-25）
 *
 * 由来：B站 有些视频连 AI 字幕都没有，debrief 只能读到简介 + 热评。
 * 现在补一条：DASH 音频 → ffmpeg 直接拉流并转 16k 单声道 → faster-whisper 转写 → 删临时文件。
 *
 * 成本控制：
 *   · 只在「没有字幕轨」时调用（调用方判断）
 *   · duration 超过 maxMinutes 直接跳过（转写是 CPU 跑，长片太贵）
 *   · 两段临时产物都落在 dataDir/_tmp，转写完立即删除
 *
 * 外部依赖（可用环境变量覆盖）：
 *   PEIKAN_FFMPEG  ffmpeg 可执行文件，默认 "ffmpeg"（PATH 里找）
 *   PEIKAN_PYTHON  python 可执行文件，默认 "python"
 *   PEIKAN_ASR_MODEL  faster-whisper 模型，默认 "small"
 */
export async function transcribe(sdk, dataDir, { bvid = "", aid = 0, cid = 0, duration = 0, maxMinutes = 20, lang = "", maxSeconds = 0 } = {}) {
  if (!aid || !cid) return { ok: false, note: "缺 aid/cid" };
  const mins = Number(duration) / 60;
  if (mins > maxMinutes) {
    return { ok: false, note: `视频 ${Math.round(mins)} 分钟，超过转写上限 ${maxMinutes} 分钟` };
  }

  // 1) 取音频流地址
  let audioUrl = "";
  try {
    const json = await signedRequest(sdk, dataDir, `${API}/x/player/wbi/playurl`, { avid: aid, cid, fnval: 16, fourk: 1 });
    if (json?.code !== 0) return { ok: false, note: `playurl code=${json?.code}` };
    const list = json?.data?.dash?.audio || [];
    const best = list.slice().sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
    audioUrl = String(best?.baseUrl || best?.base_url || "");
    if (!audioUrl) return { ok: false, note: "没有 dash 音频流" };
  } catch (e) {
    return { ok: false, note: `取音频失败：${e && e.message ? e.message : e}` };
  }

  const tmpDir = path.join(dataDir, "_tmp");
  const stamp = `${bvid || "v"}-${Date.now()}`;
  const wav = path.join(tmpDir, `asr-${stamp}.wav`);
  const ffmpeg = process.env.PEIKAN_FFMPEG || "ffmpeg";
  const python = process.env.PEIKAN_PYTHON || "python";
  const model = process.env.PEIKAN_ASR_MODEL || "small";
  const threads = String(process.env.PEIKAN_ASR_THREADS || 8);
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "asr.py");

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // 2) ffmpeg 直接拉流并转码（不落 m4s，省一次磁盘往返）
    const ffArgs = [
      "-hide_banner", "-loglevel", "error",
      "-headers", "referer: https://www.bilibili.com/\r\nuser-agent: Mozilla/5.0",
      "-i", audioUrl,
    ];
    if (maxSeconds > 0) ffArgs.push("-t", String(Math.floor(maxSeconds)));
    ffArgs.push("-vn", "-ac", "1", "-ar", "16000", "-y", wav);
    const ff = await runProcess(ffmpeg, ffArgs, { timeoutMs: 10 * 60 * 1000 });
    if (!ff.ok || !fs.existsSync(wav)) {
      return { ok: false, note: `音频拉取失败：${String(ff.err || "").slice(-160)}` };
    }

    // 3) faster-whisper 转写（语言自动检测）
    const py = await runProcess(python, [helper, wav, model, lang || "auto", threads], { timeoutMs: 20 * 60 * 1000 });
    const line = String(py.out || "").trim().split("\n").filter(Boolean).pop() || "";
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* 下面统一报错 */ }
    if (!parsed || !parsed.ok) {
      return { ok: false, note: `转写失败：${(parsed && parsed.note) || String(py.err || "").slice(-140)}` };
    }
    const text = String(parsed.text || "").trim();
    if (!text) return { ok: false, note: "转写结果为空" };

    return {
      ok: true,
      text,
      lang: parsed.lang || "",
      seconds: parsed.seconds || 0,
      note: `音轨转写 ${parsed.lang || "?"} / ${Math.round(Number(parsed.seconds) || 0)}s`,
    };
  } catch (e) {
    return { ok: false, note: `转写异常：${e && e.message ? e.message : e}` };
  } finally {
    // 4) 临时音频一律删掉（用户要求：转完删除）
    try { fs.rmSync(wav, { force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 深读一条：详情 + 热评 + 字幕 + 弹幕热区。
 */
export async function debrief(sdk, dataDir, { bvid = "", commentLimit = 20, withDanmaku = true, withAudio = false } = {}) {
  const info = await videoInfo(sdk, dataDir, { bvid });
  if (!info.ok) return { ok: false, note: info.note, bvid };

  const [cm, sub, dm] = await Promise.all([
    comments(sdk, dataDir, { aid: info.video.aid, bvid, limit: commentLimit }),
    subtitles(sdk, dataDir, { aid: info.video.aid, cid: info.video.cid }),
    withDanmaku
      ? danmaku.analyze(sdk, dataDir, { cid: info.video.cid, duration: info.video.duration, bucketSec: 10, top: 3 })
      : Promise.resolve({ ok: false, note: "跳过" }),
  ]);

  // 没有字幕轨时，才去转音轨（贵，默认关；social 回合传 withAudio=true 打开）
  let transcript = null;
  if (!sub.ok && withAudio) {
    try {
      const tr = await transcribe(sdk, dataDir, {
        bvid, aid: info.video.aid, cid: info.video.cid, duration: info.video.duration,
      });
      if (tr.ok) transcript = tr;
    } catch { /* 转写失败不影响其余阅读 */ }
  }

  return {
    ok: true,
    bvid,
    video: info.video,
    comments: cm.items || [],
    subtitle: sub.ok ? { text: sub.text, lines: sub.lines, duration: sub.duration, lang: sub.lang } : null,
    transcript: transcript ? { text: transcript.text, lang: transcript.lang, seconds: transcript.seconds } : null,
    danmaku: dm.ok ? { total: dm.total, hotMoments: dm.hotMoments, note: dm.note } : null,
    note: [
      cm.ok ? cm.note : `评论失败：${cm.note}`,
      sub.ok ? sub.note : (transcript ? transcript.note : `字幕：${sub.note}`),
      dm.ok ? dm.note : `弹幕：${dm.note}`,
    ].join(" / "),
  };
}

// ── 写入口（P5 才实装，P2 一律拒绝）──────────────────────────────────

export async function publishComment() {
  return { ok: false, stage: "P2", note: "发布层未实装（P5），本条未发送" };
}

export async function publishDynamic() {
  return { ok: false, stage: "P2", note: "发布层未实装（P5），本条未发送" };
}

export async function sendDm() {
  return { ok: false, stage: "P2", note: "私信未实装（P5），未发送" };
}
