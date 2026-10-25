/**
 * 组 stage —— 按手册白名单
 *
 * 手册 §二：打包器「不做白名单」，对 --dir 照单全收。
 * 所以必须先自己组一个干净的 stage。
 *
 * 用法（在仓库根执行）：
 *   node pack-stage.mjs
 *   → 产物落在 ./_stage/peikan（目录名必须等于 App id，手册要求）
 *
 * 可选：
 *   PEIKAN_OWNER_MID=<主人UID> node pack-stage.mjs
 *   → 额外扫描包内是否泄漏主人 UID（不传就不扫这一项，避免把个人 UID 写进仓库）
 *
 * 排除：
 *   verify/      —— 全部是开发和测试脚本，不该进包
 *   verify/      —— 开发/测试脚本，不进包
 *   _stage/      —— 本脚本自己的产物
 *
 * 保留：
 *   index.js / manifest.json / lib/ / assets/ / ui/ / sdk/ / playbooks/ / README.md / LICENSE / DECISIONS.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根 = 本脚本所在目录（源码就在根，不再有嵌套的 peikan/ 子目录）
const SRC = path.dirname(fileURLToPath(import.meta.url));
const STAGE = path.join(SRC, "_stage", "peikan");

// 目录名必须等于 App id（手册：否则报 id does not match its directory name）
console.log("=== 清空旧 stage ===");
fs.rmSync(path.dirname(STAGE), { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const INCLUDE_DIRS = ["lib", "ui", "assets", "sdk", "playbooks"];  // sdk 是 index.js 的运行时依赖（./sdk/app-contract/*），必须随包
const INCLUDE_FILES = ["index.js", "manifest.json", "package.json", "README.md", "LICENSE", "CHANGELOG.md", "DECISIONS.md"];
const SKIP_DIRS = new Set(["verify", "sdk", "node_modules", ".git", ".tmp", "_stage"]);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const f = path.join(from, e.name);
    const t = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(f, t);
    else { fs.copyFileSync(f, t); n += 1; }
  }
  return n;
}

console.log("=== 复制白名单内容 ===");
let total = 0;

for (const d of INCLUDE_DIRS) {
  const src = path.join(SRC, d);
  if (!fs.existsSync(src)) { console.log(`  跳过 ${d}（不存在）`); continue; }
  const n = copyDir(src, path.join(STAGE, d));
  console.log(`  ${d}/  → ${n} 个文件`);
  total += n;
}

for (const f of INCLUDE_FILES) {
  const src = path.join(SRC, f);
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(STAGE, f));
  console.log(`  ${f}`);
  total += 1;
}

console.log(`\n总计 ${total} 个文件`);

// ── 隐私扫描 ──
console.log("\n=== 隐私扫描 ===");
const DANGER = [
  { name: "凭据", re: /sessdata|bili_jct|buvid3/i },
  { name: "手机号", re: /\b1[3-9]\d{9}\b/ },
  // 本机绝对路径：不写死具体用户名，按盘符+系统目录名兜
  { name: "本机绝对路径", re: /[A-Z]:[\\/]{1,2}(?:Users|Games)[\\/]/i },
];

// 主人 UID 从环境变量传入，避免把个人 UID 固化进仓库
const ownerMid = String(process.env.PEIKAN_OWNER_MID || "").trim();
if (ownerMid) DANGER.push({ name: "真实 mid", re: new RegExp(ownerMid) });

const findings = [];
function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    const ext = path.extname(e.name).toLowerCase();
    if (![".js", ".mjs", ".json", ".html", ".css", ".md", ".txt", ".svg"].includes(ext)) continue;
    const c = fs.readFileSync(p, "utf8");
    for (const d of DANGER) {
      if (d.re.test(c)) {
        // 找出命中的行，便于判断是不是误报
        const line = c.split("\n").find((l) => d.re.test(l)) || "";
        findings.push({
          file: p.replace(STAGE + "\\", ""),
          type: d.name,
          sample: line.trim().slice(0, 100),
        });
      }
    }
  }
}
scan(STAGE);

if (!findings.length) {
  console.log("✓ 未发现敏感内容");
} else {
  console.log(`发现 ${findings.length} 处，逐条看：`);
  for (const f of findings) {
    console.log(`  [${f.type}] ${f.file}`);
    console.log(`      ${f.sample}`);
  }
}
