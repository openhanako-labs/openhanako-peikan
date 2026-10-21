/**
 * 回填旧笔记的 cover / duration / pubdate / up / bvid
 *
 * 为什么要回填：42 条笔记全都没有这几个字段，界面里就没封面、没时长。
 * 做法：逐条用 view 接口补（带 200ms 间隔，避免被风控）。
 * 已有的跳过，不重复请求。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const DATA = "W:/Games/Hanako/.hanako/app-data/peikan";
const NOTES = path.join(DATA, "notes", "index.json");
const COVERS = path.join(DATA, "covers");

// 凭据
const credPath = path.join(DATA, "credentials.json");
const cred = JSON.parse(fs.readFileSync(credPath, "utf8"));
console.log("凭据:", Object.keys(cred).join(", "));

function headers() {
  const h = {
    referer: "https://www.bilibili.com/",
    origin: "https://www.bilibili.com",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    accept: "application/json, text/plain, */*",
  };
  const pairs = [];
  // 常见 cookie 名
  if (cred.SESSDATA) pairs.push("SESSDATA=" + cred.SESSDATA);
  if (cred.bili_jct) pairs.push("bili_jct=" + cred.bili_jct);
  if (cred.DedeUserID) pairs.push("DedeUserID=" + cred.DedeUserID);
  if (cred.buvid3) pairs.push("buvid3=" + cred.buvid3);
  if (pairs.length) h.cookie = pairs.join("; ");
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = JSON.parse(fs.readFileSync(NOTES, "utf8"));
console.log("笔记总数:", list.length);

let filled = 0, skipped = 0, failed = 0;

for (let i = 0; i < list.length; i += 1) {
  const n = list[i];
  const bv = (String(n.bvid || "") || String(n.source || "")).match(/BV[0-9A-Za-z]+/)?.[0] || "";
  if (!bv) { skipped += 1; continue; }

  // 已经有完整信息就跳过 —— 但封面文件必须真存在，
  // 光有 cover 字段不算（之前就是这样：字段有值、文件没下，UI 一片空白）
  // 2026-10-21：标题空也不能算完整（界面上全是「无题」）。
  const coverFile0 = path.join(COVERS, `${bv}.jpg`);
  const hasTitle = Boolean(String(n.title || "").trim());
  if (n.duration > 0 && n.pubdate > 0 && n.bvid && fs.existsSync(coverFile0) && hasTitle) {
    skipped += 1;
    continue;
  }

  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: headers() });
    const j = await r.json();
    if (j?.code !== 0) {
      console.log(`  ${i + 1}/${list.length} ${bv} → code=${j?.code} ${j?.message || ""}`);
      failed += 1;
      await sleep(400);
      continue;
    }
    const d = j.data;
    n.bvid = bv;
    n.duration = d.duration || 0;
    n.pubdate = d.pubdate || 0;
    n.up = d.owner?.name || "";
    // 2026-10-21：无标题的笔记用视频原题的前 24 字补上
    // （规则路径写的，不是她的判断，但至少要能扫）
    if (!n.title || !String(n.title).trim()) {
      n.title = String(d.title || "").slice(0, 24);
    }
    if (!n.cover) n.cover = `${bv}.jpg`;

    // 顺手补封面文件（没有才下）
    const coverFile = path.join(COVERS, `${bv}.jpg`);
    if (!fs.existsSync(coverFile) && d.pic) {
      try {
        const ir = await fetch(d.pic, {
          headers: { referer: "https://www.bilibili.com/", "user-agent": "Mozilla/5.0" },
        });
        if (ir.ok) {
          const buf = Buffer.from(await ir.arrayBuffer());
          fs.writeFileSync(coverFile, buf);
        }
      } catch { /* 封面失败不影响主流程 */ }
    }

    filled += 1;
    console.log(`  ${i + 1}/${list.length} ${bv} ✓ ${n.up} ${n.duration}s`);
    await sleep(200);
  } catch (e) {
    failed += 1;
    console.log(`  ${i + 1}/${list.length} ${bv} ✗ ${e && e.message ? e.message : e}`);
    await sleep(500);
  }
}

fs.writeFileSync(NOTES, JSON.stringify(list, null, 2));
console.log(`\n回填完成：${filled} 条补上，${skipped} 条跳过，${failed} 条失败`);
