/**
 * verify/ui-harness/shot.mjs — 截图 + 收集 JS 错误
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "shots");
const PORT = Number(process.argv[2] || 7791);

import fs from "node:fs";
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await import("playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });
page.on("pageerror", (e) => errors.push("[pageerror] " + e.message));

const targets = [
  ["studio.html", "studio-notes.png"],
  ["panel.html", "panel.png"],
  ["settings.html", "settings.png"],
];

for (const [file, out] of targets) {
  errors.length = 0;
  await page.goto(`http://127.0.0.1:${PORT}/${file}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, out), fullPage: false });
  console.log(`\n=== ${file} → ${out} ===`);
  if (errors.length) {
    errors.forEach((e) => console.log("  ✗ " + e.slice(0, 200)));
  } else {
    console.log("  ✓ 无 JS 错误");
  }
}

// 主卡切页签各拍一张
await page.goto(`http://127.0.0.1:${PORT}/studio.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
for (const tab of ["rhythm", "ledger", "setup"]) {
  const el = await page.$(`nav.tabs a[data-tab="${tab}"]`);
  if (!el) { console.log(`\n=== tab ${tab} === 找不到页签`); continue; }
  await el.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `tab-${tab}.png`), fullPage: false });
  console.log(`\n=== tab ${tab} === 已截图`);
}

await browser.close();
console.log("\n截图目录:", OUT);
