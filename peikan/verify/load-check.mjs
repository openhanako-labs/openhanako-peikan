/**
 * verify/load-check.mjs — 真加载所有 lib 模块，抓 ReferenceError
 *
 * 为什么不用静态分析：AST 太松会误报一片，太紧漏报。
 * 真 import 一次最快——模块顶层一旦引用了不存在的名字，立刻炸。
 *
 * 局限：函数体内部的引用只有在被调用时才炸。
 * 所以这里额外把每个模块的导出函数「摸一遍类型」，不做调用。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const LIB = path.join(APP, "lib");

const FILES = fs.readdirSync(LIB).filter((f) => f.endsWith(".js"));

let pass = 0, fail = 0;

for (const file of FILES) {
  const p = path.join(LIB, file);
  try {
    const mod = await import(pathToFileURL(p).href);
    const names = Object.keys(mod).filter((k) => k !== "default");
    const fns = names.filter((k) => typeof mod[k] === "function");
    pass++;
    console.log(`✓ ${file}  (${fns.length} 个导出函数)`);
  } catch (e) {
    fail++;
    console.log(`✗ ${file}`);
    console.log(`   ${e && e.message ? e.message : e}`);
  }
}

console.log(`\n结果：${pass} 加载成功，${fail} 失败`);
process.exit(fail ? 1 : 0);
