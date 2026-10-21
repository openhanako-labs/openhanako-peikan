/**
 * 组 stage —— 按手册白名单
 *
 * 手册 §二：打包器「不做白名单」，对 --dir 照单全收。
 * 所以必须先自己组一个干净的 stage。
 *
 * 排除：
 *   verify/      —— 全部是开发和测试脚本，不该进包
 *   sdk/         —— 宿主注入的 SDK 类型，装机时会自带
 *
 * 保留：
 *   index.js / manifest.json / lib/ / assets/ / ui/ / package.json / README.md
 */
import fs from "node:fs";
import path from "node:path";

const SRC = "W:/Games/Hanako/Work/ophelia-bili-scaffold/peikan";
const STAGE = "W:/Games/Hanako/Work/ophelia-bili-scaffold/_stage/peikan";

// 目录名必须等于 App id（手册：否则报 id does not match its directory name）
console.log("=== 清空旧 stage ===");
fs.rmSync(path.dirname(STAGE), { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const INCLUDE_DIRS = ["lib", "ui", "assets"];
const INCLUDE_FILES = ["index.js", "manifest.json", "package.json", "README.md", "LICENSE", "CHANGELOG.md"];
const SKIP_DIRS = new Set(["verify", "sdk", "node_modules", ".git", ".tmp"]);

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
  { name: "真实 mid", re: /347410973/ },
  { name: "手机号", re: /\b1[3-9]\d{9}\b/ },
  { name: "本机绝对路径", re: /W:\\Games|C:\\Users\\Administrator/i },
];

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
