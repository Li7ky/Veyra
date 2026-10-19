#!/usr/bin/env node
/**
 * IPC 契约检查（Tauri 版）：
 *   1. 前端用到的每个 window.veyra.xxx 方法，必须在 src-tauri/src/commands.rs 的 dispatch 里有分支；
 *   2. 前端订阅的每个 onXxx，必须在 src/tauri-bridge.ts 的 EVENTS 里注册；
 *   3. EVENTS 映射到的事件名，必须在 Rust 侧至少 emit 过一次。
 * 任何一项缺失都直接失败，避免「前端点了没反应」这类静默回归。
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const rust = read("src-tauri/src/commands.rs");
const bridge = read("src/tauri-bridge.ts");

const methods = new Set();
for (const line of rust.split(/\r?\n/)) {
  if (!line.includes("=>")) continue;
  const m = line.match(/^\s*((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*=>/);
  if (!m) continue;
  for (const q of m[1].matchAll(/"([^"]+)"/g)) methods.add(q[1]);
}

const events = new Map();
for (const m of bridge.matchAll(/^\s*(on[A-Za-z0-9_]+):\s*"([^"]+)"/gm)) {
  events.set(m[1], m[2]);
}

const emitted = new Set();
const rsDir = path.join(root, "src-tauri/src");
for (const file of fs.readdirSync(rsDir)) {
  if (!file.endsWith(".rs")) continue;
  const text = fs.readFileSync(path.join(rsDir, file), "utf8");
  // 兼容 app.emit("x", …) 与 tauri::Emitter::emit(&app, "x", …) 两种写法
  for (const m of text.matchAll(/(?:\.emit|::emit)\(\s*(?:&?[A-Za-z0-9_:.]+,\s*)?"([^"]+)"/g)) {
    emitted.add(m[1]);
  }
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return [p];
  });

const files = walk(path.join(root, "src")).filter(
  (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts")
);

const problems = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/window\.veyra\??\.([A-Za-z0-9_]+)/g)) {
    const name = m[1];
    if (name.startsWith("on")) {
      if (!events.has(name)) problems.push(`${rel}: 事件 ${name} 未在 tauri-bridge EVENTS 中注册`);
    } else if (!methods.has(name)) {
      problems.push(`${rel}: 方法 ${name} 未在 commands.rs dispatch 中实现`);
    }
  }
}

for (const [key, event] of events) {
  if (!emitted.has(event)) problems.push(`tauri-bridge: ${key} -> ${event} 在 Rust 侧没有任何 emit`);
}

if (problems.length) {
  console.error("IPC 契约检查失败：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`IPC 契约检查通过：${methods.size} 个方法、${events.size} 个事件`);
