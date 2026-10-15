#!/usr/bin/env node
/**
 * IPC 契约一致性校验
 *
 * 背景：Veyra 的 IPC 契约分散在三处手工维护——
 *   1. electron/preload.cjs   —— 实际暴露给渲染进程的 API
 *   2. electron/main.cjs      —— ipcMain.handle 注册的 channel
 *   3. src/vite-env.d.ts      —— 渲染进程看到的 TypeScript 类型
 *
 * 三处不同步会静默产生线上问题（例如 onCoreProgress 曾在 preload/main 中实现，
 * 但类型定义漏了，导致 tsc 报错、新代码无法使用该能力）。
 *
 * 本脚本把三处提取出来做机器比对，在 CI/提交前拦住漂移。
 * 用法：node scripts/check-ipc-contract.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

/** 提取所有 ipcMain.handle("channel") */
function extractHandled(src) {
  return [...src.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** 提取 preload 中 ipcRenderer.invoke("channel") */
function extractInvoked(src) {
  return [...src.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** 提取 preload 中 ipcRenderer.on("channel") —— 主→渲染的单向事件 */
function extractListened(src) {
  return [...src.matchAll(/ipcRenderer\.on\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** 提取主进程 webContents.send("channel") 或 mainWindow?.webContents.send */
function extractSent(src) {
  return [...src.matchAll(/webContents\.send\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * 校验类型声明覆盖率：preload 暴露的每个 API 名（invoke 包装的函数名）
 * 在 vite-env.d.ts 中都应有对应声明。
 * preload 写法：`name: (args) => ipcRenderer.invoke("channel", ...)`
 */
function extractPreloadApiNames(src) {
  const names = [];
  const re = /^\s{2}([A-Za-z_$][\w$]*)\s*:\s*(?:\(|\(.*?\)\s*=>)/gm;
  for (const m of src.matchAll(re)) names.push(m[1]);
  return names;
}

const mainSrc = read("electron/main.cjs");
const preloadSrc = read("electron/preload.cjs");
const dtsSrc = read("src/vite-env.d.ts");

const handled = new Set(extractHandled(mainSrc));
const invoked = new Set(extractInvoked(preloadSrc));
const listened = new Set(extractListened(preloadSrc));
const sent = new Set(extractSent(mainSrc));

const problems = [];
const warn = [];

// 1) preload invoke 的 channel 必须有对应的 main handler
const invokeSatisfied = new Set([...handled].filter((c) => invoked.has(c)));
for (const c of invoked) if (!handled.has(c)) problems.push(`preload 调用了未注册的 channel: ${c}`);

// 2) main handler 应全部经 preload 暴露（否则渲染进程用不到，属于死代码线索）
for (const c of handled) if (!invoked.has(c)) warn.push(`main 注册但 preload 未暴露: ${c}`);

// 3) preload 监听的事件必须有 main 侧 send（除非由内核/其它模块推送）
for (const c of listened)
  if (!sent.has(c)) warn.push(`preload 监听 ${c}，但主进程未发现对应 send（确认是否由其它模块推送）`);

// 4) 类型声明覆盖率
const preloadApiNames = extractPreloadApiNames(preloadSrc);
const missingTypes = preloadApiNames.filter((n) => !new RegExp(`\\b${n}\\b`).test(dtsSrc));

console.log("── IPC 契约校验 ──────────────────────────────");
console.log(`main.cjs    ipcMain.handle   : ${handled.size}`);
console.log(`preload.cjs ipcRenderer.invoke: ${invoked.size}`);
console.log(`preload.cjs 事件监听         : ${listened.size}`);
console.log(
  `vite-env.d.ts 覆盖 API       : ${preloadApiNames.length - missingTypes.length}/${preloadApiNames.length}`
);

if (warn.length) {
  console.log("\n提示（不阻断）:");
  for (const w of warn) console.log("  · " + w);
}

if (missingTypes.length) {
  console.log("\n类型声明缺失（preload 暴露但 vite-env.d.ts 未声明）:");
  for (const n of missingTypes) console.log("  ✗ " + n);
  problems.push(`${missingTypes.length} 个 preload API 缺少类型声明`);
}

if (problems.length) {
  console.log("\n❌ 契约校验失败:");
  for (const p of problems) console.log("  " + p);
  process.exit(1);
}

console.log("\n✅ IPC 契约一致");
