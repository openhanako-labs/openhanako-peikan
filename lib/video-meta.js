/**
 * 视频元数据缓存 + 笔记自动关联
 *
 * 为什么不再「让模型传 cover/duration」：
 *   实测两轮，她写了 4 条笔记，noteHints 明明在 debrief 的返回里，
 *   她一次都没传。要求模型复制字段是个不可靠的设计 —— 它有自己的注意力。
 *
 * 改成：
 *   · debrief 时把 view 接口的元数据落进 video-meta.json（按 BV 索引）
 *   · bili_note 时按 source 里的 BV 号自动补 cover/duration/pubdate/up/bvid
 *   · 模型传了就以模型为准（万一它想改）
 */
import fs from "node:fs";
import path from "node:path";

const FILE = "video-meta.json";

function cachePath(dataDir) {
  return path.join(dataDir, FILE);
}

function readCache(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(dataDir), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(dataDir, obj) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath(dataDir), JSON.stringify(obj, null, 0));
    return true;
  } catch {
    return false;
  }
}

/** 从任意字符串里抽 BV 号 */
export function bvOf(s) {
  const m = String(s || "").match(/BV[0-9A-Za-z]+/);
  return m ? m[0] : "";
}

/**
 * 存一条视频的元数据。
 * video 是 client.debrief 返回的那个对象（含 duration/pubdate/up/pic/cid）。
 */
export function saveMeta(dataDir, bvid, video = {}, coverName = "") {
  const bv = bvOf(bvid);
  if (!bv) return false;
  const c = readCache(dataDir);
  const prev = c[bv] || {};
  c[bv] = {
    bvid: bv,
    title: String(video.title || video.video?.title || prev.title || ""),
    up: String(video.up || video.owner?.name || prev.up || ""),
    duration: Number(video.duration || prev.duration || 0),
    pubdate: Number(video.pubdate || prev.pubdate || 0),
    cover: String(coverName || prev.cover || `${bv}.jpg`),
    // 2026-10-21：把封面地址存下来。以前不存，导致 frames.cover 每次都要
    // 再请求一次 view 接口拿 pic —— 而那个请求在 App 沙箱里容易被拦，
    // 结果就是 duration 有值、封面永远下不下来。
    //
    // 注意：B站 CDN 给的是 http://，宿主只允许 https://。存的时候就转。
    pic: (() => {
      const raw = String(video.pic || prev.pic || "");
      return raw.replace(/^http:\/\//i, "https://");
    })(),
    at: new Date().toISOString(),
  };

  // 缓存别无限涨：超过 500 条，删最老的
  const keys = Object.keys(c);
  if (keys.length > 500) {
    keys
      .sort((a, b) => String(c[a].at || "").localeCompare(String(c[b].at || "")))
      .slice(0, keys.length - 500)
      .forEach((k) => { delete c[k]; });
  }
  return writeCache(dataDir, c);
}

/** 按 BV 取元数据（没有就 null） */
export function getMeta(dataDir, bvid) {
  const bv = bvOf(bvid);
  if (!bv) return null;
  const c = readCache(dataDir);
  return c[bv] || null;
}

/**
 * 给一条待写入的笔记补全视频元数据。
 * 规则：模型明确传了（非空）就用模型的；否则按 BV 从缓存取。
 *
 * 2026-10-20 补：如果缓存里也没有（她可能没调过 bili_debrief 就直接写笔记），
 * 返回 missingBv，由调用方决定要不要现查。
 */
export function enrichNote(dataDir, note) {
  const bv = bvOf(note.bvid || note.source);
  const out = { ...note };
  if (bv && !out.bvid) out.bvid = bv;

  const m = bv ? getMeta(dataDir, bv) : null;
  if (!m) {
    // 标记缺元数据，让调用方能补
    if (bv && (!out.duration || out.duration === 0)) out.missingBv = bv;
    return out;
  }

  if (!out.cover) out.cover = m.cover || "";
  if (!out.duration || out.duration === 0) out.duration = m.duration || 0;
  if (!out.pubdate || out.pubdate === 0) out.pubdate = m.pubdate || 0;
  if (!out.up) out.up = m.up || "";
  delete out.missingBv;
  return out;
}

/**
 * 现查一条视频的元数据并写进缓存。
 * 用于 bili_note 时的兜底：她可能没深读就直接记了。
 */
export async function fetchAndSave(sdk, dataDir, bvid) {
  const bv = bvOf(bvid);
  if (!bv) return null;
  try {
    const client = await import("./client.js");
    const r = await client.debrief(sdk, dataDir, { bvid: bv, commentLimit: 1 });
    if (!r || !r.ok) return null;
    saveMeta(dataDir, bv, r.video || {});

    // 封面文件也要真下下来 —— 之前只存了元数据，cover 字段有值但文件不存在，
    // UI 上就是一片空白（/frame 返回 404 → 整块隐藏）。
    //
    // 2026-10-21：之前这里是 catch {} 完全静默，结果 13 条笔记封面全没下，
    // 也没人知道为什么。现在失败会留痕（写到 video-meta 的 _errors）。
    let coverErr = "";
    try {
      const frames = await import("./frames.js");
      const cv = await frames.cover(sdk, dataDir, { bvid: bv, pic: r.video?.pic });
      if (!cv || cv.ok !== true) coverErr = String(cv?.error || "cover 返回非 ok");
    } catch (e) {
      coverErr = String(e && e.message ? e.message : e).slice(0, 120);
    }

    if (coverErr) {
      const c2 = readCache(dataDir);
      if (c2[bv]) {
        c2[bv].coverError = coverErr;
        writeCache(dataDir, c2);
      }
    }

    return getMeta(dataDir, bv);
  } catch {
    return null;
  }
}
