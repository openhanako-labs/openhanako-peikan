/**
 * verify/imports-check.mjs — 静态检查「用了但没导入」
 *
 * 起因：同一类 bug 犯了三次（wake / store2 / loadCredentials），
 *   node --check 只验语法，运行时才崩。
 * 这个脚本把 lib/ 下每个文件的**裸标识符使用**对照它的 import 列表。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const LIB = path.join(APP, "lib");

/** 从 import 语句提取所有本地绑定名 */
function importedNames(src) {
  const names = new Set();

  // import * as X from "..."
  for (const m of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from/g)) names.add(m[1]);

  // import { a, b as c } from "..."
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = /\bas\s+(\w+)$/.exec(t);
      names.add(asMatch ? asMatch[1] : t.split(/\s+/)[0]);
    }
  }

  // import X from "..."
  for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) names.add(m[1]);

  return names;
}

/** 收集本文件声明的函数/常量/类名 */
function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+(\w+)/g)) names.add(m[1]);
  return names;
}

/** 已知的全局/内置/宿主注入名 */
const BUILTINS = new Set([
  "console", "process", "Buffer", "URL", "URLSearchParams", "Date", "Math", "JSON",
  "Promise", "Object", "Array", "String", "Number", "Boolean", "Set", "Map", "Error",
  "TypeError", "RegExp", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "structuredClone", "TextEncoder", "TextDecoder", "fetch", "Headers", "Response",
  "require", "module", "exports", "globalThis", "undefined", "null", "true", "false",
  "sdk", "ctx", "log", "logger", "dataDir", "payload", "args", "opts", "cfg", "r", "e",
  "async", "await", "return", "if", "else", "for", "while", "of", "in", "new", "this",
]);

const FILES = fs.readdirSync(LIB).filter((f) => f.endsWith(".js"));

let problems = 0;

for (const file of FILES) {
  const p = path.join(LIB, file);
  const src = fs.readFileSync(p, "utf8");

  const imported = importedNames(src);
  const declared = declaredNames(src);
  const known = new Set([...imported, ...declared, ...BUILTINS]);

  // 找「形如 moduleName.something」的使用
  const usedModules = new Set();
  for (const m of src.matchAll(/\b([a-z][A-Za-z0-9_]*)\.[a-zA-Z_$]/g)) {
    usedModules.add(m[1]);
  }

  // 找「形如 bareFunc( 」的调用（排除方法调用 a.b() ）
  const usedCalls = new Set();
  for (const m of src.matchAll(/(?<![.\w])([a-z][A-Za-z0-9_]*)\s*\(/g)) {
    usedCalls.add(m[1]);
  }

  const suspects = [];
  for (const name of [...usedModules, ...usedCalls]) {
    if (known.has(name)) continue;
    if (name.length <= 2) continue;
    // 排除 JS 关键字和常见局部变量
    if (/^(if|for|while|switch|catch|typeof|instanceof|return|function|await|async|new|delete|void|yield|class|const|let|var|import|export|default|throw|try|finally|do|else|case|break|continue|constructor|then|catch|finally|slice|split|join|map|filter|reduce|forEach|find|some|every|includes|replace|trim|toString|toISOString|toLocaleDateString|toLocaleString|getTime|setHours|setDate|charCodeAt|codePointAt|padStart|startsWith|endsWith|indexOf|localeCompare|sort|push|pop|shift|unshift|concat|keys|values|entries|has|get|set|add|delete|clear|match|matchAll|test|exec|apply|call|bind)$/.test(name)) continue;
    suspects.push(name);
  }

  if (suspects.length) {
    problems++;
    console.log(`⚠ ${file}`);
    console.log(`   疑似未定义: ${[...new Set(suspects)].join(", ")}`);
  }
}

if (problems === 0) {
  console.log(`✓ ${FILES.length} 个文件，没发现「用了但没导入」`);
} else {
  console.log(`\n共 ${problems} 个文件需人工确认`);
  process.exit(1);
}
