#!/usr/bin/env node
/**
 * 安装 git hooks 到仓库根 .git/hooks。
 *
 * 不用 husky 的原因：本项目 git 根在 src/ 的上级目录，husky 的默认布局假设
 * package.json 与 .git 同级，在这里需要额外配置 cwd，收益不如一个显式脚本。
 *
 * 用法：node scripts/install-git-hooks.mjs
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let gitRoot;
try {
  gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(here, ".."),
    encoding: "utf8",
  }).trim();
} catch {
  console.error("✗ 不在 git 仓库内，跳过 hook 安装");
  process.exit(1);
}

const hooksDir = join(gitRoot, ".git", "hooks");
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

const src = resolve(here, "pre-commit");
const dst = join(hooksDir, "pre-commit");

copyFileSync(src, dst);
try {
  chmodSync(dst, 0o755);
} catch {
  /* Windows 上 chmod 可能无效，Git for Windows 仍会执行该钩子 */
}

console.log(`✅ pre-commit 钩子已安装: ${dst}`);
console.log("   跳过校验： git commit --no-verify");
