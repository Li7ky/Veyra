/**
 * 内核下载完整性校验
 *
 * 背景：mihomo / sing-box 内核是从 GitHub Releases 下载的可执行文件，
 * 下载后会被直接执行（甚至注册为系统服务）。此前两个下载脚本都不做任何
 * 完整性校验——一旦下载链路被劫持或镜像返回损坏/篡改的二进制，
 * 应用会静默执行它，属于典型的供应链风险。
 *
 * 本模块从 GitHub 官方 release 的 sha256 摘要文件比对实际下载内容。
 * 校验不通过时抛错，由调用方终止安装（不落地、不执行）。
 *
 * 用法：
 *   import { verifyArchiveChecksum } from "./verify-checksum.mjs";
 *   await verifyArchiveChecksum(filePath, { repo: "MetaCubeX/mihomo", tag, assetName, proxy });
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** 流式计算文件 sha256，避免把上百 MB 的压缩包读进内存 */
export function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

/**
 * 通过 PowerShell 拉取官方校验文件（复用下载脚本已有的代理设置）。
 * GitHub release 通常附带 *.sha256 或 checksums.txt。
 */
function fetchText(url, proxy) {
  const proxyArg = proxy ? `-Proxy '${String(proxy).replace(/'/g, "''")}'` : "";
  const script = `
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
(Invoke-WebRequest -Uri '${url}' ${proxyArg} -Headers @{ 'User-Agent'='veyra' } -UseBasicParsing).Content
`;
  return execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
}

/** 从校验文件内容里找出目标文件对应的 sha256（兼容多种排版） */
export function parseChecksumFile(content, assetName) {
  if (!content) return null;
  const lines = String(content).split(/\r?\n/);
  const hexRe = /\b([0-9a-fA-F]{64})\b/;

  // 优先精确匹配文件名
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (line.includes(assetName)) {
      const m = line.match(hexRe);
      if (m) return m[1].toLowerCase();
    }
  }
  // 退而求其次：文件里只有一个摘要时直接用它
  const all = [...String(content).matchAll(new RegExp(hexRe, "g"))].map((m) => m[1].toLowerCase());
  return all.length === 1 ? all[0] : null;
}

/**
 * 校验下载文件。
 * @returns {Promise<{verified: boolean, reason?: string, expected?: string, actual?: string}>}
 *   verified=false 表示「未能校验」（拿不到官方摘要），调用方自行决定是否放行；
 *   校验失败（摘要不一致）会直接抛错，因为这是明确的安全信号。
 */
export async function verifyArchiveChecksum(filePath, { repo, tag, assetName, proxy = "" } = {}) {
  if (!existsSync(filePath)) throw new Error(`校验失败：文件不存在 ${filePath}`);
  const actual = await fileSha256(filePath);

  const candidates = [
    `https://github.com/${repo}/releases/download/${tag}/checksums.txt`,
    `https://github.com/${repo}/releases/download/${tag}/${assetName}.sha256`,
    `https://github.com/${repo}/releases/download/${tag}/sha256sum.txt`,
  ];

  let expected = null;
  for (const url of candidates) {
    try {
      const content = fetchText(url, proxy);
      expected = parseChecksumFile(content, assetName);
      if (expected) break;
    } catch {
      // 该候选文件不存在，继续尝试下一个
    }
  }

  if (!expected) {
    return { verified: false, reason: "未能获取官方 sha256 摘要", actual };
  }

  if (expected !== actual) {
    throw new Error(
      `内核完整性校验失败（可能的下载损坏或被篡改）\n  期望 sha256: ${expected}\n  实际 sha256: ${actual}\n  文件: ${filePath}`
    );
  }

  return { verified: true, expected, actual };
}
