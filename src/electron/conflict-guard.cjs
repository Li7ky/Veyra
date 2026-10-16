/**
 * conflict-guard.cjs — Veyra-omini 双向互斥与冲突检测引擎
 *
 * 能力覆盖：
 *   1. 启动前全面检测（进程 / 端口 / 系统代理 / DNS / 路由表）
 *   2. 运行时持续监控（定时轮询 + 事件推送）
 *   3. 自身标识注册（marker 文件 + 命名端口 + PID 锁）
 *   4. 单实例互斥（防止 Veyra-omini 自身多开）
 *
 * 设计原则：
 *   - 任何外部命令失败均降级为"无冲突"，不因检测失败阻塞启动
 *   - 端口扫描全部并发，总超时控制在 3s 内
 *   - 自身标识对外部只读，不影响已运行的其他代理
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
const { execFile, exec } = require("child_process");
const os = require("os");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// 代理进程名数据库
// 格式: [进程名(不含.exe兼容匹配), 显示名, {opt: 自定义端口偏移}]
// 覆盖 Windows 主流 + macOS 常见 + 小众开源工具
// ---------------------------------------------------------------------------
const PROXY_PROCESS_DB = [
  // —— Clash 家族 ——
  ["clash.exe", "Clash for Windows", { family: "clash" }],
  ["clash-verge.exe", "Clash Verge Rev", { family: "clash" }],
  ["verge.exe", "Clash Verge", { family: "clash" }],
  ["clash-verge-service.exe", "Clash Verge Service", { family: "clash" }],
  ["clash-rev.exe", "Clash.Rev", { family: "clash" }],
  ["clash-win.exe", "Clash Premium", { family: "clash" }],
  ["clash-mihomo.exe", "Clash Mihomo", { family: "clash" }],
  ["clashx-pro.exe", "ClashX Pro", { family: "clash" }],
  ["clashx.exe", "ClashX", { family: "clash" }],
  ["clash-service.exe", "Clash Service", { family: "clash" }],
  ["macha.exe", "Macha Clash", { family: "clash" }],
  // —— v2ray / Xray ——
  ["v2rayn.exe", "v2rayN", { family: "v2ray" }],
  ["v2rayn-core.exe", "v2rayN Core", { family: "v2ray" }],
  ["v2ray.exe", "v2ray Core", { family: "v2ray" }],
  ["xray.exe", "Xray", { family: "v2ray" }],
  ["v2raya.exe", "v2rayA", { family: "v2ray" }],
  ["qv2ray.exe", "Qv2ray", { family: "v2ray" }],
  ["nekoray.exe", "NekoRay", { family: "v2ray" }],
  ["nekobox.exe", "NekoBox", { family: "v2ray" }],
  ["hysteria.exe", "Hysteria", { family: "v2ray" }],
  ["hysteria2.exe", "Hysteria2", { family: "v2ray" }],
  // —— Shadowsocks ——
  ["shadowsocks.exe", "Shadowsocks Windows", { family: "ss" }],
  ["shadowsocks-qt5.exe", "Shadowsocks-Qt5", { family: "ss" }],
  ["ss-local.exe", "Shadowsocks libev", { family: "ss" }],
  ["ssr-local.exe", "ShadowsocksR", { family: "ss" }],
  ["electron-ssr.exe", "electron-ssr", { family: "ss" }],
  ["sstap.exe", "SSTap", { family: "ss" }],
  // —— Trojan ——
  ["trojan.exe", "Trojan", { family: "trojan" }],
  ["trojan-go.exe", "Trojan-Go", { family: "trojan" }],
  // —— TUIC / Hysteria2 / 其他 ——
  ["tuic.exe", "TUIC", { family: "other" }],
  ["leaf.exe", "Leaf Proxy", { family: "other" }],
  ["sing-box.exe", "sing-box (外部)", { family: "other" }],
  ["mihomo.exe", "Mihomo (外部)", { family: "other" }],
  ["dae.exe", "dae", { family: "other" }],
  ["daed.exe", "daed", { family: "other" }],
  // —— 游戏/特殊工具 ——
  ["netch.exe", "Netch", { family: "game" }],
  ["sstap-beta.exe", "SSTap Beta", { family: "game" }],
  ["privoxy.exe", "Privoxy", { family: "other" }],
  ["proxifier.exe", "Proxifier", { family: "other" }],
  ["proxifier64.exe", "Proxifier x64", { family: "other" }],
  // —— Cloudflare WARP ——
  ["warp-svc.exe", "Cloudflare WARP", { family: "warp" }],
  ["cloudflare-warp.exe", "Cloudflare WARP GUI", { family: "warp" }],
  // —— Outline ——
  ["outline.exe", "Outline Client", { family: "outline" }],
  ["outline-service.exe", "Outline Service", { family: "outline" }],
  // —— macOS 兼容（跨平台构建时用） ——
  ["clash-verge-rev", "Clash Verge Rev (macOS)"],
  ["Clash Verge Rev", "Clash Verge Rev (macOS)"],
  ["v2rayA", "v2rayA (macOS)"],
];

// ---------------------------------------------------------------------------
// 已知代理默认端口数据库
// 格式: [端口, 检测名, 对应软件家族]
// 覆盖 40+ 端口，允许自定义端口时跳过匹配
// ---------------------------------------------------------------------------
const KNOWN_PROXY_PORTS = [
  // Clash 家族
  [7890, "Clash HTTP", "clash"],
  [7891, "Clash SOCKS", "clash"],
  [7892, "Clash Mixed", "clash"],
  [9090, "Clash API", "clash"],
  [9091, "Clash API (alt)", "clash"],
  [9097, "Clash Mixed (Verge)", "clash"],
  [9098, "Verge TUN DNS", "clash"],
  [3300, "Miyabei/Clash alt", "clash"],
  // v2rayN / Xray
  [10808, "v2rayN HTTP", "v2ray"],
  [10809, "v2rayN SOCKS", "v2ray"],
  [10810, "v2rayN Mixed", "v2ray"],
  [10813, "v2rayN Alt", "v2ray"],
  [15835, "v2rayA API", "v2ray"],
  [2017, "v2rayA Alt", "v2ray"],
  [1080, "通用 SOCKS", "v2ray"],
  [1081, "SOCKS alt", "v2ray"],
  [8080, "HTTP alt", "v2ray"],
  [3128, "Squid/Privoxy", "v2ray"],
  [10086, "NekoRay", "v2ray"],
  // Shadowsocks
  [1080, "SS Local", "ss"],
  [65534, "SS Alt", "ss"],
  // Trojan
  [443, "Trojan (shared with HTTPS)", "trojan"],
  // sing-box
  [9099, "sing-box API", "other"],
  // Privoxy
  [8118, "Privoxy", "other"],
  // TunSafe/WireGuard
  [51820, "WireGuard TunSafe", "other"],
  // Outline
  [443, "Outline (shared)", "outline"],
];

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------
let _monitorTimer = null;
let _monitorCallback = null;
let _markerCreated = false;
let _myPid = process.pid;
let _markerPath = "";
let _singletonFd = null;
// 自家内核（由主进程 spawn 的 mihomo/sing-box）的 PID 集合。
// 用途：进程扫描时把这些 PID 排除，避免「自己启动的内核」被误报成「其它代理软件」。
// 由主进程在内核启动/退出/收养时通过 setOwnCorePids() 同步。
let _ownCorePids = new Set();

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 异步检测单个端口是否被占用，返回 Promise<boolean> */
function probePort(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(val);
    };
    s.on("connect", () => finish(true));
    s.on("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** 并行扫描所有已知端口（排除自身使用端口），返回命中列表 */
async function scanPorts(myPorts = []) {
  const myPortSet = new Set(myPorts.map(String));
  const targets = KNOWN_PROXY_PORTS.filter(([port]) => !myPortSet.has(String(port)));
  const results = await Promise.all(
    targets.map(async ([port, label, family]) => {
      const hit = await probePort(port, "127.0.0.1", 1200);
      if (hit) return { type: "port", port, label, family, severity: "high" };
      // 同时扫 0.0.0.0 有可能占用在 "Any" 地址上
      const hitAny = await probePort(port, "0.0.0.0", 800);
      if (hitAny) return { type: "port", port, label: `${label} (全局)`, family, severity: "high" };
      return null;
    })
  );
  return results.filter(Boolean);
}

/** 自定义端口扫描：主动传入要探测的端口列表（用于检测用户配置的端口被占用情况）
 *  返回命中列表，每个元素含 port 和 severity */
async function scanCustomPorts(ports, host = "127.0.0.1") {
  if (!Array.isArray(ports) || ports.length === 0) return [];
  const results = await Promise.all(
    ports.map(async (port) => {
      const hit = await probePort(port, host, 1200);
      if (!hit) return null;
      // 查一下这个端口对应哪个已知代理软件
      const known = KNOWN_PROXY_PORTS.find((kp) => kp[0] === port);
      if (known) return { type: "port", port, label: known[1], family: known[2], severity: "critical" };
      return { type: "port", port, label: `端口 ${port} 被占用`, severity: "critical" };
    })
  );
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// 进程检测（跨平台）
// ---------------------------------------------------------------------------

/** Windows: tasklist CSV 匹配（解析出 PID，排除自家内核） */
function detectProcsWindows() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      const out = String(stdout || "").toLowerCase();
      // CSV 行示例: "mihomo.exe","6260","Console","1","100,000 K"
      const rows = out
        .split(/\r?\n/)
        .map((line) => {
          const m = line.match(/^"([^"]+)","(\d+)"/);
          return m ? { name: m[1], pid: Number(m[2]) } : null;
        })
        .filter(Boolean);
      const hits = [];
      for (const [procRaw, label] of PROXY_PROCESS_DB) {
        const proc = procRaw.toLowerCase();
        const baseName = proc.replace(/\.exe$/, "");
        // 跳过已知误报白名单进程
        if (isFalsePositiveProc(baseName)) continue;
        // 主路径：按解析出的进程名匹配，并排除自家内核 PID
        const matched = rows.filter((r) => r.name === proc);
        if (matched.length) {
          // 该名字的所有实例都是自家内核才算「不是冲突」；
          // 只要还存在一个非自家实例，就保留命中（真外部软件不能被放过）。
          if (matched.every((r) => isOwnCorePid(r.pid))) continue;
          // 收集非自家内核的 PID，供一键关闭使用
          const externalPids = matched.filter((r) => !isOwnCorePid(r.pid)).map((r) => r.pid);
          hits.push({ type: "process", proc: baseName, label, pids: externalPids });
          continue;
        }
        // 兜底：CSV 结构意外变化时退回纯文本匹配（无法做 PID 排除）
        if (!rows.length) {
          const quoted = out.includes(`"${proc}"`);
          const bare = out.includes(`,${baseName},`) || out.startsWith(`${baseName}`);
          if (quoted || bare) hits.push({ type: "process", proc: baseName, label });
        }
      }
      // 去重
      const seen = new Set();
      resolve(hits.filter((h) => (seen.has(h.label) ? false : seen.add(h.label))));
    });
  });
}

/** macOS / Linux: ps 匹配（带 PID，排除自家内核） */
function detectProcsUnix() {
  return new Promise((resolve) => {
    const cmd = process.platform === "darwin"
      ? "ps -ax -o pid=,comm="
      : "ps -eo pid=,comm=";
    exec(cmd, { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => {
          const m = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!m) return null;
          const base = m[2].trim().split("/").pop().toLowerCase();
          return { name: base, pid: Number(m[1]) };
        })
        .filter(Boolean);
      const hits = [];
      const seen = new Set();
      for (const [procRaw, label] of PROXY_PROCESS_DB) {
        const base = procRaw.toLowerCase().replace(/\.exe$/, "");
        if (seen.has(base)) continue;
        const matched = rows.filter((r) => r.name === base || r.name === `${base}.exe`);
        if (!matched.length) continue;
        // 所有实例都是自家内核才跳过（真外部实例继续报）
        if (matched.every((r) => isOwnCorePid(r.pid))) continue;
        seen.add(base);
        // 收集非自家内核的 PID，供一键关闭使用
        const externalPids = matched.filter((r) => !isOwnCorePid(r.pid)).map((r) => r.pid);
        hits.push({ type: "process", proc: base, label, pids: externalPids });
      }
      resolve(hits);
    });
  });
}

/** 平台无关入口 */
function detectProxyProcesses() {
  if (process.platform === "win32") return detectProcsWindows();
  return detectProcsUnix();
}

// ---------------------------------------------------------------------------
// 系统级检测（Windows 注册表 + macOS scutil）
// ---------------------------------------------------------------------------

/** 检测系统代理是否已被其他应用设置 */
function detectSystemProxyConflict() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    // 读取注册表判断代理是否开启
    execFile("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null);
        const enabled = /0x1$|0x1\s/i.test(stdout);
        if (!enabled) return resolve(null);
        // 进一步检测代理服务器地址
        execFile("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
          { windowsHide: true, timeout: 3000 }, (err2, stdout2) => {
            if (err2) return resolve({ type: "system-proxy", label: "系统代理已开启（未知软件）" });
            const match = stdout2.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
            const addr = match ? match[1].trim() : "未知";
            resolve({ type: "system-proxy", label: `系统代理被占用 → ${addr}`, server: addr });
          });
      });
  });
}

/** 检测 FakeIP DNS (53端口) 是否被占用 */
function detectDnsConflict() {
  return new Promise((resolve) => {
    probePort(53, "127.0.0.1", 1000).then((hit) => {
      if (hit) resolve({ type: "dns", label: "本地 DNS (127.0.0.1:53) 被占用" });
      else resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// 已知误报进程白名单（WSL / Docker / Hyper-V / 系统服务等）
// 命中白名单的进程不视为代理冲突
// ---------------------------------------------------------------------------
const FALSE_POSITIVE_PROCS = new Set([
  // Hyper-V
  "vmwp", "vmmem", "vmms", "hns",
  // WSL
  "wsl", "wslservice", "wslhost",
  // Docker
  "docker", "docker-desktop", "dockerd", "docker-desktop-ci", "com.docker", "vpnkit",
  // Windows 系统
  "svchost", "mmcss", "lsass", "services", "wininit", "csrss", "smss",
  "conhost", "taskhostw", "sihost", "ctfmon", "dwm", "taskmgr",
  "fontdrvhost", "registry", "system", "idle",
  // 常用非代理软件
  "nvcontainer", "igccservice", "onenote", "teams", "outlook", "chrome",
  "firefox", "msedge", "opera", "vivaldi", "brave",
]);

/** 判断进程名是否为已知误报 */
function isFalsePositiveProc(procName) {
  return FALSE_POSITIVE_PROCS.has(procName.toLowerCase());
}

/** 检测路由表中是否有其他 VPN 隧道路由（智能排除正常路由器） */
function detectRouteConflict() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    execFile("route", ["print", "-4"], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout || "");
      // 解析 Active Routes 表
      // 形如: 0.0.0.0    0.0.0.0    192.168.1.1    192.168.1.100    35
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d+)$/);
        if (!m) continue;
        const gateway = m[1];
        const iface = m[2];
        const metric = parseInt(m[3], 10);
        // 跳过标准私网网关（正常路由器 192.168.x.x / 10.x.x.x / 172.16-31.x.x）
        if (isPrivateGateway(gateway)) continue;
        // 跳过网关 == 接口的低 metric 路由（Hyper-V / WSL / Docker 默认路由）
        if (gateway === iface && metric < 10) continue;
        // 公网 IP 网关且非本地 → 极可能是 VPN 隧道
        if (!isPrivateGateway(gateway) && gateway !== "127.0.0.1" && iface !== gateway) {
          resolve({ type: "route", label: `检测到非标准默认网关 ${gateway}（可能为 VPN 隧道）`, gateway });
          return;
        }
        // 高 metric 路由也是 VPN 的强信号
        if (metric > 500) {
          resolve({ type: "route", label: `默认网关 metric 异常 (${metric})，可能为 VPN 隧道`, gateway });
          return;
        }
      }
      resolve(null);
    });
  });
}

/** 同步「自家内核」PID 集合（主进程在 spawn/退出/收养时调用） */
function setOwnCorePids(pids) {
  const list = Array.isArray(pids) ? pids : pids == null ? [] : [pids];
  _ownCorePids = new Set(list.map(Number).filter((n) => Number.isFinite(n) && n > 0));
}

/** 判断某个 PID 是否为自家内核 */
function isOwnCorePid(pid) {
  return _ownCorePids.has(Number(pid));
}

/** 判断是否为正常的私网默认网关（路由器） */
function isPrivateGateway(ip) {
  if (!ip) return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 || a === 127) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 自身标识注册（让外部代理软件能发现 Veyra-omini）
// ---------------------------------------------------------------------------

/** 注册自身标识——外部代理软件可据此发现我们在运行 */
function registerSelfIdentity(opts = {}) {
  try {
    const { pid, mixedPort, controllerPort, secret, coreMode } = opts;
    const idDir = path.join(os.tmpdir(), "veyra-omini-id");
    fs.mkdirSync(idDir, { recursive: true });
    _markerPath = path.join(idDir, "instance.json");
    const payload = {
      app: "Veyra-omini",
      version: opts.version || "unknown",
      pid: pid || _myPid,
      mixedPort: mixedPort || null,
      controllerPort: controllerPort || null,
      coreMode: coreMode || "unknown",
      startedAt: new Date().toISOString(),
      session: crypto.randomBytes(8).toString("hex"),
    };
    // 先写临时再 rename 原子替换
    const tmp = _markerPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, _markerPath);
    _markerCreated = true;
    return { ok: true, path: _markerPath, payload };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 清理自身标识（退出时调用） */
function unregisterSelfIdentity() {
  try {
    if (_markerCreated && _markerPath && fs.existsSync(_markerPath)) {
      fs.unlinkSync(_markerPath);
    }
  } catch {}
  _markerCreated = false;
}

/** 读取自身的当前标识信息 */
function getSelfIdentity() {
  if (!_markerCreated || !_markerPath || !fs.existsSync(_markerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(_markerPath, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 自身互斥——检测另一个 Veyra-omini 实例是否在运行
// ---------------------------------------------------------------------------

/** 检测是否已有其他 Veyra-omini 在运行 */
function detectSelfConflict() {
  try {
    const idPath = path.join(os.tmpdir(), "veyra-omini-id", "instance.json");
    if (!fs.existsSync(idPath)) return null;
    const id = JSON.parse(fs.readFileSync(idPath, "utf8"));
    if (!id || !id.pid) return null;
    // 标记文件由本进程在内核启动成功时写入：PID 等于自身就是「我们」，
    // 而不是「另一个实例」。此前不做自查，导致内核一启动自检必报单实例冲突。
    if (Number(id.pid) === _myPid || Number(id.pid) === process.pid) return null;
    // 检测进程是否存在
    if (process.platform === "win32") {
      return new Promise((resolve) => {
        execFile("tasklist", ["/fi", `PID eq ${id.pid}`, "/fo", "csv", "/nh"],
          { windowsHide: true, timeout: 3000 }, (err, stdout) => {
            if (err) return resolve(null);
            const out = String(stdout || "");
            if (out.includes(`"${id.pid}"`) || out.split("\n").some((l) => l.trim().startsWith(`${id.pid}`))) {
              resolve({
                type: "self",
                label: `Veyra-omini 已在运行 (PID ${id.pid})`,
                pid: id.pid,
                mixedPort: id.mixedPort,
              });
            } else {
              // 过期 marker，清理之
              try { fs.unlinkSync(idPath); } catch {}
              resolve(null);
            }
          });
      });
    } else {
      // Unix: kill -0 检测
      try {
        process.kill(id.pid, 0);
        return { type: "self", label: `Veyra-omini 已在运行 (PID ${id.pid})`, pid: id.pid };
      } catch {
        try { fs.unlinkSync(idPath); } catch {}
        return null;
      }
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 完整冲突扫描（合并所有检测手段）
// ---------------------------------------------------------------------------

/**
 * 执行完整冲突扫描
 * @param {object} opts
 * @param {number[]} opts.myPorts  — 自身不使用这些端口（跳过检测）
 * @param {boolean} opts.includeSystem  — 是否包含系统级检测（注册表/DNS/路由）
 * @param {boolean} opts.includeSystemProxy — 是否仅包含系统代理检测
 * @returns {Promise<{ conflicts: Array, summary: string }>}
 */
async function fullScan(opts = {}) {
  const { myPorts = [], myCustomPorts = [], includeSystem = true, includeSystemProxy = false } = opts;
  const all = [];
  const seen = new Set();
  // 记录严重与中等冲突的数量
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;

  const push = (item) => {
    if (!item) return;
    const key = item.type === "process" ? `proc:${item.proc}` : `port:${item.port}`;
    // 避免同一软件被进程和端口各报一次
    const altKey = item.type === "process" ? item.label : `${item.port}`;
    if (seen.has(key) || seen.has(altKey)) return;
    seen.add(key);
    seen.add(altKey);
    // 默认严重度为 medium（纯进程检测）
    if (!item.severity) item.severity = "medium";
    if (item.severity === "critical") criticalCount++;
    else if (item.severity === "high") highCount++;
    else mediumCount++;
    all.push(item);
  };

  // 1. 自身互斥检测（最高优先级）
  const selfHit = await detectSelfConflict();
  if (selfHit) {
    selfHit.severity = "critical";
    push(selfHit);
  }

  // 2. 并发：已知端口扫描 + 进程扫描 + 自定义端口扫描
  const [portHits, procHits, customHits] = await Promise.all([
    scanPorts(myPorts),
    detectProxyProcesses(),
    scanCustomPorts(myCustomPorts),
  ]);
  portHits.forEach(push);
  procHits.forEach((h) => { h.severity = "medium"; push(h); });
  customHits.forEach((h) => { h.severity = "critical"; push(h); });

  // 3. 系统级检测
  if (includeSystem || includeSystemProxy) {
    const [sysProxy, dns, route] = await Promise.all([
      detectSystemProxyConflict(),
      includeSystem ? detectDnsConflict() : Promise.resolve(null),
      includeSystem ? detectRouteConflict() : Promise.resolve(null),
    ]);
    if (sysProxy) sysProxy.severity = "high";
    if (dns) dns.severity = "high";
    if (route) route.severity = "medium";
    push(sysProxy);
    push(dns);
    push(route);
  }

  // 生成摘要
  const summary = all.length === 0
    ? "✓ 未检测到其他代理软件"
    : `检测到 ${all.length} 个可能的冲突：${all.map((a) => a.label).join("、")}`;

  return {
    conflicts: all,
    summary,
    severity: criticalCount > 0 ? "critical" : highCount > 0 ? "high" : mediumCount > 0 ? "medium" : "none",
    counts: { critical: criticalCount, high: highCount, medium: mediumCount },
  };
}

// ---------------------------------------------------------------------------
// 运行时持续监控
// ---------------------------------------------------------------------------

/**
 * 启动轮询监控，每 intervalMs 检测一次。
 * 当发现新冲突且之前的检测为空时，调用 onConflict(items)。
 * 当冲突消失时，调用 onResolved()。
 * @param {function} onConflict — 发现新冲突时回调
 * @param {function} onResolved — 冲突消失时回调
 * @param {number} intervalMs — 轮询间隔毫秒
 * @param {number[]} myCustomPorts — 自身端口（这些端口被占升级为 critical）
 */
function startMonitor(onConflict, onResolved, intervalMs = 5000, myCustomPorts = []) {
  stopMonitor();
  let lastHits = [];
  let firstScanDone = false;
  _monitorCallback = { onConflict, onResolved };

  _monitorTimer = setInterval(async () => {
    // 首轮完整扫描（含多个 probePort，单端口超时可达 1.2s）完成前不做 diff：
    // 否则会以空的 lastHits 为基准，把启动前就已存在的冲突全部当「新出现」误报
    if (!firstScanDone) return;
    try {
      const { conflicts } = await fullScan({ includeSystem: false, myCustomPorts });
      const curKeys = new Set(conflicts.map((c) => `${c.type}:${c.proc || c.port}`));
      const prevKeys = new Set(lastHits.map((c) => `${c.type}:${c.proc || c.port}`));

      const newItems = conflicts.filter((c) => !prevKeys.has(`${c.type}:${c.proc || c.port}`));
      const resolved = lastHits.filter((c) => !curKeys.has(`${c.type}:${c.proc || c.port}`));

      if (newItems.length > 0 && typeof onConflict === "function") {
        onConflict(newItems);
      }
      if (resolved.length > 0 && lastHits.length > 0 && conflicts.length === 0 && typeof onResolved === "function") {
        onResolved();
      }
      lastHits = conflicts;
    } catch {
      // 检测失败不传播
    }
  }, intervalMs);
  // 首次立即执行；完成后才允许 interval 做 diff
  (async () => {
    try {
      const { conflicts } = await fullScan({ includeSystem: false, myCustomPorts });
      lastHits = conflicts;
    } catch {} finally {
      firstScanDone = true;
    }
  })();
}

function stopMonitor() {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
  fullScan,
  scanPorts,
  scanCustomPorts,
  detectProxyProcesses,
  detectSystemProxyConflict,
  detectDnsConflict,
  detectRouteConflict,
  detectSelfConflict,
  setOwnCorePids,
  registerSelfIdentity,
  unregisterSelfIdentity,
  getSelfIdentity,
  startMonitor,
  stopMonitor,
  PROXY_PROCESS_DB,
  KNOWN_PROXY_PORTS,
};
