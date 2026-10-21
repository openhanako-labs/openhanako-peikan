/**
 * lib/dynamic.js — 动态的改与带图发
 *
 * 两个参考 dsh-bili-whale 的做法：
 *   ① edit-dynamic：端点是从网页 JS 里扒出来的
 *      "/x/dynamic/feed/" + (dyn_id_str ? "edit" : "create") + "/dyn"
 *      编辑时必须把当前图片原样带回去，否则会把图弄丢。
 *   ② dynamic-image：先传图到 upload_bfs，再发 scene=2 的动态。
 *
 * 立场：两个都是写通道，必须过闸门（gate.check）。
 */
import path from "node:path";
import fs from "node:fs";
import { loadCredentials, headers as authHeaders } from "./auth.js";
import * as store from "./store.js";
import * as risk from "./risk.js";
import * as gate from "./gate.js";
import * as quota from "./quota.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function hdrs(cred, referer = "https://www.bilibili.com/") {
  return {
    "user-agent": UA,
    referer,
    origin: "https://www.bilibili.com",
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? "; buvid3=" + cred.buvid3 : ""}`,
  };
}

async function jget(sdk, url, opts = {}) {
  const r = await sdk.network.fetch(url, opts);
  return typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
}

/**
 * 把 B站 的原始报错翻成人话。
 *
 * 由来（2026-10-20）：对着一个不存在的 dynId 预演，
 * 弹回来的是「code=500 Cannot read property 'only_fans' of undefined」
 * —— 那是 B站 后端自己报错，对用户零意义。
 */
export function explainDynamicError(code, message) {
  const c = Number(code);
  const m = String(message || "");

  // 后端 500 + 空指针 → 基本就是「找不到这条」
  if (c === 500 && /only_fans|undefined|Cannot read/.test(m)) {
    return "这条动态不存在，或者已经删了（也可能是私密动态，她看不到）";
  }
  if (c === 500) return "B站 那边出错了（不是你的问题），过一会儿再试";
  if (c === -404 || c === 404) return "找不到这条动态";
  if (c === -101) return "登录态失效了，需要重新登一下";
  if (c === -111) return "被限流了，先别动，过一阵再说";
  if (c === -400) return "参数不对（可能正文太长或格式有问题）";
  if (c === -403) return "没权限改这条（不是她发的？）";
  if (c === 41010 || c === 41011) return "内容被风控拦了，换个说法试试";
  if (c === 412) return "被风控了，需要先过验证";

  // 认不出就把原文附上，至少能查
  return `出错了（code=${c || "?"}）：${m || "没有更多信息"}`;
}

/**
 * 读一条动态的当前内容（编辑前必须先读，否则会把图弄丢）。
 */
export async function fetchDynamic(sdk, dataDir, dynId) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "未配置凭据" };
  const id = String(dynId || "").replace(/[^0-9]/g, "");
  if (!id) return { ok: false, error: "缺 dyn_id" };

  try {
    const j = await jget(sdk, `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${id}&features=itemOpusStyle`, {
      method: "GET", headers: hdrs(cred, `https://www.bilibili.com/opus/${id}`),
    });
    if (j?.code !== 0) return { ok: false, error: explainDynamicError(j?.code, j?.message) };
    const major = j?.data?.item?.modules?.module_dynamic?.major;
    const opus = major?.opus ?? major?.draw;
    const pics = (opus?.pics ?? []).map((p) => ({
      img_src: p.url, img_width: p.width, img_height: p.height,
    }));
    const text = opus?.summary?.text || "";
    return { ok: true, dynId: id, type: major?.type || "", text, pics };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 编辑动态。不传 pics 就沿用当前的（防止把图弄丢）。
 */
export async function editDynamic(sdk, dataDir, { dynId, text, cfg = {}, live = false } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "未配置凭据" };

  const body = String(text || "").trim();
  if (!body) return { ok: false, error: "正文为空" };
  if (body.length > 1000) return { ok: false, error: `正文 ${body.length} 字，超过 1000 上限` };

  // 先读现状：图片必须原样带回去
  const cur = await fetchDynamic(sdk, dataDir, dynId);
  if (!cur.ok) return { ok: false, error: `读不到原动态：${cur.error}` };

  // 闸门
  // target 传空：动态是发在自己的主页，不是「去别人那里」——
  // 白名单管的是「能不能去找别人说话」，不该拦自己的动态（传 "dynamic" 会被当成 uid 拦掉）。
  const g = gate.check(dataDir, store, quota, {
    kind: "dynamic", text: body, target: "", config: cfg,
  });
  if (!g.ok) {
    return { ok: false, blocked: true, decision: g.decision, reason: (g.reasons || []).join("；") };
  }

  const payload = {
    dyn_id_str: String(cur.dynId),
    dyn_req: {
      scene: cur.pics.length ? 2 : 1,
      content: { contents: [{ raw_text: body, type: 1, biz_id: "" }] },
      ...(cur.pics.length ? { pics: cur.pics } : {}),
      meta: { app_meta: { from: "create.dynamic.web", mobi_app: "web" } },
    },
  };

  const preview = {
    method: "POST",
    url: "https://api.bilibili.com/x/dynamic/feed/edit/dyn?csrf=***&platform=web",
    dynId: cur.dynId,
    textLength: body.length,
    keepPics: cur.pics.length,
  };

  if (!live) {
    store.audit(dataDir, { action: "edit-dynamic", decision: "DRY_RUN", dynId: cur.dynId });
    return { ok: true, mode: "dry-run", preview, note: "预演：payload 已组装，未发送。真发需 live=true" };
  }
  // 风控进闸（2026-10-20 补）：放在 live 之后 —— 预演不发请求，不该被冷却拦
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}`, level: rkPre.level };
  }


  try {
    const j = await jget(
      sdk,
      `https://api.bilibili.com/x/dynamic/feed/edit/dyn?csrf=${encodeURIComponent(String(cred.bili_jct))}&platform=web`,
      {
        method: "POST",
        headers: { ...hdrs(cred, `https://www.bilibili.com/opus/${cur.dynId}`), "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (j?.code === 0) {
      store.audit(dataDir, { action: "edit-dynamic", decision: "SENT", dynId: cur.dynId });
      return { ok: true, mode: "live", dynId: cur.dynId, url: `https://t.bilibili.com/${cur.dynId}` };
    }
    const rk = risk.record(dataDir, j?.code, { where: "改动态" });
    store.audit(dataDir, { action: "edit-dynamic", decision: "FAILED", dynId: cur.dynId, code: j?.code, riskTripped: rk.tripped });
    return { ok: false, error: explainDynamicError(j?.code, j?.message) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 读图片尺寸（PNG/JPEG 头，不依赖第三方库） */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), kind: "png" };
  }
  // JPEG：扫 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), kind: "jpg" };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  }
  return null;
}

/**
 * 发带图动态。先传图到 upload_bfs，再发 scene=2。
 */
export async function publishDynamicImage(sdk, dataDir, { text, imagePath, cfg = {}, live = false } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "未配置凭据" };

  const body = String(text || "").trim();
  if (!body) return { ok: false, error: "正文为空" };

  const p = String(imagePath || "");
  if (!p || !fs.existsSync(p)) return { ok: false, error: `图片不存在：${p}` };

  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { return { ok: false, error: `读图失败：${e.message}` }; }
  const dims = imageSize(buf);
  if (!dims) return { ok: false, error: "解析不出图片尺寸，无法组装 pics" };

  // 闸门（target 传空：动态发在自己主页，不受白名单约束）
  const g = gate.check(dataDir, store, quota, {
    kind: "dynamic", text: body, target: "", config: cfg,
  });
  if (!g.ok) {
    return { ok: false, blocked: true, decision: g.decision, reason: (g.reasons || []).join("；") };
  }

  const preview = {
    steps: [
      "POST https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs（multipart）",
      "POST https://api.bilibili.com/x/dynamic/feed/create/dyn（scene=2）",
    ],
    image: { path: p, bytes: buf.length, ...dims },
    textLength: body.length,
  };

  if (!live) {
    store.audit(dataDir, { action: "dynamic-image", decision: "DRY_RUN" });
    return { ok: true, mode: "dry-run", preview, note: "预演：未上传、未发送。真发需 live=true" };
  }
  // 风控进闸（2026-10-20 补）：放在 live 之后 —— 预演不发请求，不该被冷却拦
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}`, level: rkPre.level };
  }


  try {
    // ① 传图
    const fd = new FormData();
    const mime = dims.kind === "png" ? "image/png" : "image/jpeg";
    fd.append("file_up", new Blob([buf], { type: mime }), `upload.${dims.kind}`);
    fd.append("category", "daily");
    fd.append("csrf", String(cred.bili_jct));

    const upRes = await sdk.network.fetch("https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs", {
      method: "POST",
      headers: { "user-agent": UA, referer: "https://www.bilibili.com/", cookie: hdrs(cred).cookie },
      body: fd,
    });
    const upJ = typeof upRes.json === "function" ? await upRes.json() : JSON.parse(String(upRes));
    if (upJ?.code !== 0) return { ok: false, stage: "upload", error: `图片上传失败：${explainDynamicError(upJ?.code, upJ?.message)}` };

    const d0 = upJ.data || {};
    const imgSrc = d0.image_url || d0.url || "";
    if (!imgSrc) return { ok: false, stage: "upload", error: "上传成功但拿不到 image_url" };

    // ② 发动态
    const payload = {
      dyn_req: {
        scene: 2,
        content: { contents: [{ raw_text: body, type: 1, biz_id: "" }] },
        pics: [{
          img_src: imgSrc,
          img_width: Number(d0.image_width) || dims.width,
          img_height: Number(d0.image_height) || dims.height,
          img_size: Number(d0.img_size) || Math.round(buf.length / 1024),
        }],
        meta: { app_meta: { from: "create.dynamic.web", mobi_app: "web" } },
      },
    };

    const j = await jget(
      sdk,
      `https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(String(cred.bili_jct))}&platform=web`,
      {
        method: "POST",
        headers: { ...hdrs(cred, "https://t.bilibili.com/"), "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (j?.code === 0) {
      const dynId = j.data?.dyn_id_str ?? j.data?.dyn_id ?? "";
      store.audit(dataDir, { action: "dynamic-image", decision: "SENT", dynId });
      try { quota.record(dataDir, { type: "dynamic", target: "dynamic", note: body.slice(0, 40) }); } catch { /* 忽略 */ }
      return { ok: true, mode: "live", dynId, imageUrl: imgSrc, url: dynId ? `https://t.bilibili.com/${dynId}` : "" };
    }
    const rk2 = risk.record(dataDir, j?.code, { where: "发带图动态" });
    store.audit(dataDir, { action: "dynamic-image", decision: "FAILED", code: j?.code, riskTripped: rk2.tripped });
    return { ok: false, stage: "create", error: explainDynamicError(j?.code, j?.message) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
