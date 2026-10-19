/**
 * 应用更新用到的纯函数：版本解析/比较、安装包资产挑选。
 *
 * 抽成独立模块的原因：main.cjs 依赖 Electron，无法在单测里 require；
 * 而这些字符串比较恰恰最容易出错（beta.10 vs beta.9、带不带 v 前缀、资产名变体）。
 */

function parseAppVersion(v) {
  // 允许两段式（v1.10）：GitHub tag 与 package.json 并不总是三段。
  // 强要求三段时 v1.10 会解析失败、退回 localeCompare 字典序，
  // 于是 1.10 被判成比 1.9 旧，更新提示不出现或误报「有新版」。
  const m = String(v || "")
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] || 0),
    pre: m[4] || "",
  };
}

/** 正数表示 a 比 b 新。正式版高于同号测试版。 */
function compareAppVersion(a, b) {
  const pa = parseAppVersion(a);
  const pb = parseAppVersion(b);
  // 解析不出来时按数值分段比较，绝不用 localeCompare：
  // 字典序会把 "1.10" 排在 "1.9" 前面，方向恰好相反。
  if (!pa || !pb) return compareLoose(String(a), String(b));
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
}

/** 兜底比较：逐段按「能转数字就按数字，否则按字符串」比较。 */
function compareLoose(a, b) {
  const split = (s) =>
    String(s || "")
      .replace(/^v/i, "")
      .split(/[.\-+_]/)
      .filter(Boolean);
  const sa = split(a);
  const sb = split(b);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function pickSetupAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return (
    list.find((a) => /Setup-.*-x64\.exe$/i.test(a.name || "")) ||
    list.find((a) => /\.exe$/i.test(a.name || "") && !/blockmap/i.test(a.name || "")) ||
    null
  );
}

/**
 * 生成「卸载后重装」用的批处理脚本内容。
 *
 * 为什么落盘成 .cmd 而不是 spawn("cmd.exe", ["/c", 命令串])：
 * Node 传数组参数时会重新加引号并转义内部引号，cmd 收到的是字面量 \"C:\...\"，
 * 而 NSIS 默认安装在 Program Files（路径含空格），卸载器因此根本不会执行。
 *
 * 为什么用 ping 而不是 timeout 做延时：
 * 子进程 stdio 忽略后 stdin 指向 NUL，timeout /t 会以
 * 「Input redirection is not supported」立即退出，延时实际为 0。
 */
function buildUpdateScript(uninstaller, installer) {
  // % 在批处理里会被变量展开，路径含 % 时需写成 %%
  const q = (p) => `"${String(p == null ? "" : p).replace(/"/g, '""').replace(/%/g, "%%")}"`;
  return [
    "@echo off",
    "ping -n 3 127.0.0.1 >nul",
    `${q(uninstaller)} /S`,
    "ping -n 6 127.0.0.1 >nul",
    `start "" ${q(installer)}`,
  ].join("\r\n");
}

/** 从 markdown 文本提取有序列表项（- / * / 有序），返回去空后的数组。 */
function extractListItems(text) {
  const items = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/);
    if (m && m[1]) items.push(m[1]);
  }
  return items;
}

/**
 * 从 GitHub release 正文解析「更新内容」弹窗所需的数据。
 * 供 app:updateNotes 使用：新版本包里固化的 changelog.json 不一定包含
 * 它自己的条目（实测 beta.5 就是如此），此时用检查更新时缓存的
 * release 告示兜底 —— 与 Clash Verge（tauri-plugin-updater，说明来自
 * 检查时的 release 元数据而非新包）同一设计。
 * 返回 null 表示无法解析出有效内容（调用方回退到内置 changelog）。
 */
function parseReleaseNotes(body, tag) {
  const text = String(body || "").trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const title = (lines.find((l) => l.trim()) || "").replace(/^#+\s*/, "").trim();
  const dateMatch = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const date = dateMatch ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}` : undefined;
  const listText = text.slice(text.search(/^\s*(?:[-*+]|\d+[.)])\s/m));
  const items = extractListItems(listText);
  if (!items.length) return null;
  return {
    version: String(tag || "").replace(/^v/i, ""),
    date,
    title: title || undefined,
    channel: /beta|alpha|rc|dev|test/i.test(tag || "") ? "beta" : "stable",
    items,
  };
}

/**
 * 从 Windows 注册表 ProxyServer 值解析可用代理地址。
 * 只接受 127.0.0.1 / localhost 回环地址（外部代理软件几乎都在本机回环监听），
 * 非回环（公司网关之类）不自动使用，仍走直连兜底。
 * 兼容三种形态：
 *   "127.0.0.1:7897"                     —— 单一 host:port
 *   "http=127.0.0.1:1080;https=127.0.0.1:1080" —— 协议分列（取 http/https 项）
 *   "127.0.0.1:7897;https=127.0.0.1:1080" —— 混合（第一项是通配 host:port）
 * 返回 "http://127.0.0.1:port" 或 null。
 */
function parseWinProxyServer(server) {
  const raw = String(server || "").trim();
  if (!raw) return null;
  const parts = raw.split(/[;,\s]+/).filter(Boolean);
  let pick = null;
  for (const p of parts) {
    const m = p.match(/^(?:(https?|socks5?)=)?([^=]+):(\d{2,5})$/i);
    if (!m) continue;
    const [, scheme, host, port] = m;
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(host.trim())) continue;
    if (!scheme) {
      // 无协议前缀的第一项 = 通配所有协议，优先级最高
      pick = `http://127.0.0.1:${port}`;
      break;
    }
    // 记住 http 或 https 项（ socks 项 openStream 不支持，跳过）
    if (/^https?$/i.test(scheme) && !pick) pick = `http://127.0.0.1:${port}`;
  }
  return pick;
}

/**
 * 从检查更新/下载共用的候选通道构建器的输入，排除指向 Veyra 自家端口的
 * 系统代理（自家端口另有一条候选，不该重复）。
 */
function isOurLoopbackPort(proxyUrl, ownPorts) {
  const m = String(proxyUrl || "").match(/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/i);
  const port = m ? Number(m[1]) : NaN;
  return Number.isFinite(port) && (ownPorts || []).includes(port);
}

module.exports = {
  parseAppVersion,
  compareAppVersion,
  pickSetupAsset,
  buildUpdateScript,
  parseReleaseNotes,
  parseWinProxyServer,
  isOurLoopbackPort,
};
