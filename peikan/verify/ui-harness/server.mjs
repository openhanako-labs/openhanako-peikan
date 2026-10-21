/**
 * verify/ui-harness/server.mjs — UI 本地渲染验证
 *
 * 目的：不装宿主，自己看到 UI 长什么样、有没有 JS 错。
 *   · 静态服务 ui/ 目录
 *   · 拦截 assets/sdk.js → 返回 mock（把 hana.api.fetch 指向本服务 /routes/*）
 *   · /routes/* → 用真实 dataDir 数据（notes/rhythm/audit 等）
 *
 * 用法：node verify/ui-harness/server.mjs [port]
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const UI = path.join(APP, "ui");
const DATA = process.env.OPHELIA_DATA_DIR || "W:/Games/Hanako/.hanako/app-data/peikan";
const PORT = Number(process.argv[2] || 7791);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

// ── mock sdk：把 hana.api.fetch 指向本服务的 /routes ──
const MOCK_SDK = `
export const hana = {
  ready() { return undefined; },
  surface: {
    getContext() { return { appId: "ophelia-bili", slot: "card" }; },
    onContextChanged(cb) { setTimeout(function () { cb({ appId: "ophelia-bili", slot: "card" }); }, 30); return function () {}; },
  },
  api: {
    fetch: function (p, opts) {
      return fetch("/routes" + p, opts || {});
    },
  },
};
`;

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")); }
  catch { return fallback; }
}

function buildRoutes(p) {
  // health
  if (p === "/health") {
    const notes = readJson("notes/index.json", []);
    const review = readJson("review/index.json", []);
    const quota = readJson("quota.json", { log: [] });
    const today = new Date().toLocaleDateString("sv-SE");
    const dayOf = (at) => { try { return new Date(at).toLocaleDateString("sv-SE"); } catch { return ""; } };
    const cnt = (share, type) => quota.log.filter((x) => dayOf(x.at) === today && (share ? x.share === true : (!x.share && x.type === type))).length;
    return {
      ok: true, stage: "P7", credentialsConfigured: true,
      // 从真实 config.json 读，不要写死 ——
      // 写死会让截图里的开关状态和真机不一致，排查时误导。
      autoPostEnabled: readJson("config.json", {}).autoPostEnabled === true,
      publishLive: readJson("config.json", {}).publishLive === true,
      allowProactiveComment: readJson("config.json", {}).allowProactiveComment === true,
      notes: notes.length,
      review: review.filter((x) => x.status === "pending").length,
      quota: {
        caps: {
          comment: { used: cnt(false, "comment"), cap: 2, left: 2 - cnt(false, "comment") },
          dynamic: { used: cnt(false, "dynamic"), cap: 1, left: 1 - cnt(false, "dynamic") },
          dm: { used: cnt(false, "dm"), cap: 3, left: 3 - cnt(false, "dm") },
          follow: { used: cnt(false, "follow"), cap: 3, left: 3 - cnt(false, "follow") },
        like: { used: cnt(false, "like"), cap: 5, left: 5 - cnt(false, "like") },
        share: { used: cnt(true, null), cap: 3, left: 3 - cnt(true, null) },
        },
      },
    };
  }
  if (p === "/notes") {
    const all = readJson("notes/index.json", []);
    return { ok: true, items: all.slice(-200).reverse() };
  }

  // 身份：助手列表 / 人格 / 选中项（跟真实路由对齐）
  if (p === "/agents") {
    // harness 里模拟两个助手，够验证渲染
    return {
      ok: true,
      agents: [
        { id: "ophelia", name: "奥菲莉娅", hasAvatar: true, avatar: "./agent-avatar?id=ophelia" },
        { id: "aimis", name: "爱弥斯", hasAvatar: true, avatar: "./agent-avatar?id=aimis" },
      ],
    };
  }
  if (p === "/identity") {
    const sel = readJson("identity.json", {});
    return {
      ok: true,
      agentId: sel.agentId || "",
      agentName: sel.agentName || "",
      hasAvatar: fs.existsSync(path.join(DATA, "avatar.png")) || fs.existsSync(path.join(DATA, "avatar.svg")),
    };
  }
  if (p === "/persona") {
    let txt = "";
    try { txt = fs.readFileSync(path.join(DATA, "persona.md"), "utf8"); } catch { txt = ""; }
    return { ok: true, persona: txt };
  }

  // 日记（跟真实 /diary 路由对齐）
  if (p.startsWith("/diary")) {
    const which = new URL(p, "http://x").searchParams.get("which") === "executive" ? "executive" : "private";
    const file = which === "private" ? "diary-private.md" : "diary-executive.md";
    let raw = "";
    try { raw = fs.readFileSync(path.join(DATA, file), "utf8"); } catch { raw = ""; }
    const parts = raw.split(/^## /m).map((s) => s.trim()).filter(Boolean);
    const items = parts.map((chunk) => {
      const nl = chunk.indexOf("\n");
      return {
        at: nl >= 0 ? chunk.slice(0, nl).trim() : chunk.trim(),
        text: nl >= 0 ? chunk.slice(nl + 1).trim() : "",
      };
    }).reverse().slice(0, 60);
    return { ok: true, which, items };
  }
  if (p.startsWith("/rhythm")) {
    const st = readJson("rhythm-state.json", {});
    return {
      ...st,
      maxWakesPerDay: 3, skipChance: 0.3,
      windows: [
        { start: 420, end: 540, label: "07:00–09:00" },
        { start: 720, end: 840, label: "12:00–14:00" },
        { start: 1200, end: 1380, label: "20:00–23:00" },
      ],
      recent: (st.history || []).slice(-6).reverse(),
    };
  }
  if (p === "/drafts") return { ok: true, items: readJson("drafts/index.json", []) };
  if (p.startsWith("/review")) {
    const all = readJson("review/index.json", []);
    return { ok: true, items: all.filter((x) => x.status === "pending") };
  }
  if (p === "/audit") {
    let lines = [];
    try { lines = fs.readFileSync(path.join(DATA, "audit.jsonl"), "utf8").split("\n").filter(Boolean); }
    catch { /* 无 */ }
    return { ok: true, items: lines.slice(-80).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse() };
  }

  // ── 新页签（互动 / 学到 / 账本的撤回）───────────────
  if (p.startsWith("/digest")) {
    const q = p.split("?")[1] || "";
    const hours = Number((q.match(/hours=(\d+)/) || [])[1]) || 24;
    // harness 不发真请求，直接返回 mock，但要标明
    return {
      ok: true, mock: true, hours, total: 0, items: [],
      note: "harness 不连 B站，这里是空壳。真数据在 App 里。",
    };
  }

  if (p === "/allowlist") {
    const cfg = readJson("config.json", {});
    const known = readJson("allowlist-known.json", {});
    const people = Object.entries(known || {}).map(([uid, name]) => ({ uid, name }));
    // config.json 里的 scope 是「逗号分隔的字符串」，不是数组。
    // 直接 Array.isArray(cfg.scope) 会永远得 false —— 截图里白名单静态一直是 0。
    const rawScope = cfg.scope;
    const staticList = Array.isArray(rawScope)
      ? rawScope
      : String(rawScope || "").split(",").map((s) => s.trim()).filter(Boolean);
    return {
      ok: true,
      static: staticList,
      dynamic: people,
      known: people,
    };
  }

  if (p === "/taste") {
    const t = readJson("taste.json", { traits: {}, divergences: [] });
    const traits = Object.entries(t.traits || {}).map(([trait, v]) => ({
      trait,
      mine: Number(v.mine || 0),
      owner: Number(v.owner || 0),
    })).sort((a, b) => Math.abs(b.mine || b.owner) - Math.abs(a.mine || a.owner));
    return { ok: true, traits, divergences: t.divergences || [], mock: false };
  }

  if (p === "/silence") {
    const s = readJson("silence.json", {});
    return { ok: true, state: s.stage || "正常", daysSinceFeedback: s.daysSince || 0, quota: s.quota };
  }

  if (p === "/likes") {
    const l = readJson("liked.json", {});
    const items = (l.items || []).map((x) => ({ ...x, kind: "赞" }));
    return { ok: true, items };
  }

  if (p === "/watch") {
    const notes = readJson("notes/index.json", []);
    const withDur = notes.filter((n) => Number(n.duration) > 0);
    const totalSec = withDur.reduce((s, n) => s + Number(n.duration), 0);
    const ups = {};
    for (const n of notes) {
      const u = String(n.up || "").trim();
      if (u) ups[u] = (ups[u] || 0) + 1;
    }
    const topUps = Object.entries(ups).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
    const weekAgo = Date.now() - 7 * 86400000;
    const recent = notes.filter((n) => { try { return new Date(n.at).getTime() >= weekAgo; } catch { return false; } });
    return {
      ok: true,
      total: notes.length,
      weekCount: recent.length,
      totalHours: Math.round(totalSec / 3600),
      avgMinutes: withDur.length ? Math.round(totalSec / withDur.length / 60) : 0,
      topUps,
    };
  }

  if (p === "/sent") {
    let lines = [];
    try { lines = fs.readFileSync(path.join(DATA, "audit.jsonl"), "utf8").split("\n").filter(Boolean); }
    catch { /* 无 */ }
    const items = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && x.decision === "SENT" && (x.action === "comment" || x.action === "dynamic" || x.action === "publish"))
      .map((x) => ({
        kind: x.action === "publish" ? "dynamic" : x.action,
        target: x.bvid || x.target || "",
        bvid: x.bvid || "",
        rpid: x.rpid || "",
        dynId: x.dynId || "",
        at: x.at, text: x.note || x.reason || "",
      }));
    return { ok: true, items };
  }
  if (p === "/config") {
    // 从真实 config.json 读 —— 写死会让设置页全是空白/未勾选，排查时误导
    const real = readJson("config.json", {});
    return { ok: true, config: real };
  }
  return { ok: false, error: "not found: " + p };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  // mock sdk
  if (p === "/assets/sdk.js") {
    res.writeHead(200, { "content-type": MIME[".js"] });
    res.end(MOCK_SDK);
    return;
  }

  // 助手头像（跟真实 /agent-avatar 对齐）
  if (p === "/agent-avatar") {
    const id = String(url.searchParams.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "");
    const home = process.env.HANAKO_HOME || path.join(os.homedir(), ".hanako");
    let found = null;
    for (const n of ["agent.png", "agent.jpg", "agent.webp"]) {
      const cand = path.join(home, "agents", id, "avatars", n);
      if (fs.existsSync(cand)) { found = cand; break; }
    }
    if (!found) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(found).toLowerCase();
    const mime = ext === ".webp" ? "image/webp" : (ext === ".jpg" || ext === ".jpeg") ? "image/jpeg" : "image/png";
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
    fs.createReadStream(found).pipe(res);
    return;
  }

  // 图片（封面 / 字幕条 / 抽帧图）—— 跟真实 App 的 /frame 路由对齐
  if (p === "/frame") {
    const kind = url.searchParams.get("kind") || "cover";
    const bvid = String(url.searchParams.get("bvid") || "").replace(/[^A-Za-z0-9]/g, "");
    const map = {
      cover: path.join(DATA, "covers", bvid + ".jpg"),
      strip: path.join(DATA, "covers", bvid + "-substrip.jpg"),
    };
    let f = map[kind];
    if (kind === "sheet") {
      try {
        const dir = path.join(DATA, "frames");
        const hit = fs.readdirSync(dir).filter((x) => x.startsWith(bvid + "-")).sort().pop();
        f = hit ? path.join(dir, hit) : "";
      } catch { f = ""; }
    }
    if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // 图片：harness 的 hana.api.fetch 会把 /frame 转发成 /routes/frame
  if (p === "/routes/frame" || p === "/routes/avatar" || p === "/routes/agent-avatar") {
    const q = url.searchParams;
    let file = null;

    if (p === "/routes/frame") {
      const kind = q.get("kind") || "cover";
      const bvid = String(q.get("bvid") || "").replace(/[^A-Za-z0-9]/g, "");
      if (kind === "cover") file = path.join(DATA, "covers", bvid + ".jpg");
      else if (kind === "strip") file = path.join(DATA, "covers", bvid + "-substrip.jpg");
      else if (kind === "sheet") {
        try {
          const dir = path.join(DATA, "frames");
          const hit = fs.readdirSync(dir).filter((x) => x.startsWith(bvid + "-")).sort().pop();
          file = hit ? path.join(dir, hit) : null;
        } catch { file = null; }
      }
    } else if (p === "/routes/avatar") {
      for (const n of ["avatar.png", "avatar.webp", "avatar.jpg", "avatar.svg"]) {
        const cand = path.join(DATA, n);
        if (fs.existsSync(cand)) { file = cand; break; }
      }
    } else {
      const id = String(q.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "");
      const home = process.env.HANAKO_HOME || path.join(os.homedir(), ".hanako");
      for (const n of ["agent.png", "agent.jpg", "agent.webp"]) {
        const cand = path.join(home, "agents", id, "avatars", n);
        if (fs.existsSync(cand)) { file = cand; break; }
      }
    }

    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".webp" ? "image/webp"
      : (ext === ".jpg" || ext === ".jpeg") ? "image/jpeg"
      : ext === ".svg" ? "image/svg+xml" : "image/png";
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // mock API
  if (p.startsWith("/routes/")) {
    const key = p.slice("/routes".length);
    const body = JSON.stringify(buildRoutes(key));
    res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
    res.end(body);
    return;
  }

  // 静态（默认 studio.html）
  let file = p === "/" ? "/studio.html" : p;
  const full = path.join(UI, file);
  if (!full.startsWith(UI)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`UI harness: http://127.0.0.1:${PORT}/studio.html`);
  console.log(`dataDir: ${DATA}`);
});
