const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, clipboard, screen, globalShortcut, dialog, Notification } = require("electron");
const os = require("os");
const { convertClashToSingbox } = require("./clash2singbox.cjs");
const profilesLib = require("./profiles.cjs");
const { enhanceAndWrite, enhance } = require("./enhance.cjs");
const vergeExt = require("./verge-ext.cjs");
const winService = require("./win-service.cjs");
const uriImport = require("./uri-import.cjs");
const streamingUnlock = require("./streaming-unlock.cjs");
let yamlLib = null;
function getYaml() {
  if (!yamlLib) {
    try {
      yamlLib = require("js-yaml");
    } catch {
      throw new Error("缺少 js-yaml，无法转换 sing-box 配置（请重装 Veyra）");
    }
  }
  return yamlLib;
}
const path = require("path");
const fs = require("fs");
const { spawn, execFile, execFileSync } = require("child_process");
const http = require("http");

const isDev = !app.isPackaged;
const DEFAULT_MIXED = 17897;
const DEFAULT_CTRL = 19097;

let MIXED_PORT = DEFAULT_MIXED;
let CONTROLLER = `127.0.0.1:${DEFAULT_CTRL}`;
let SECRET = "veyra-secret";
let mainWindow = null;
let tray = null;
let coreProc = null;
let stoppingCore = null;
let coreMemCache = { mb: 0, t: 0 };
// 内核进程内存占用（MB），带 5s 缓存避免频繁起子进程
function coreMemoryMB() {
  const now = Date.now();
  if (now - coreMemCache.t < 5000) return coreMemCache.mb;
  let mb = 0;
  try {
    const pid = coreProc && !coreProc.killed ? coreProc.pid : 0;
    if (pid) {
      if (process.platform === "win32") {
        const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
          encoding: "utf8",
          timeout: 4000,
          windowsHide: true,
        });
        const m = out.match(/"([\d,]+)\s*K"/i);
        if (m) mb = Math.round(parseInt(m[1].replace(/,/g, ""), 10) / 1024);
      } else {
        const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 4000 });
        const kb = parseInt(String(out).trim(), 10);
        if (!Number.isNaN(kb)) mb = Math.round(kb / 1024);
      }
    }
  } catch {
    /* 忽略：读不到就显示 0 */
  }
  coreMemCache = { mb, t: now };
  return mb;
}
let appSettings = null;
let coreOnline = false;
let sysProxyOn = false;
let activeCore = "mihomo"; // mihomo | singbox
let isQuitting = false;
// 内核 API 连续探测失败次数。连续 3 次失败即判离线并把托盘打灰，
// 避免 controller 僵死时托盘/界面硬绿、与体感不一致。
let apiFailStreak = 0;

const userData = () => app.getPath("userData");
const configDir = () => path.join(userData(), "config");
const runtimeConfig = () => path.join(configDir(), "config.yaml");
const profilesDir = () => path.join(configDir(), "profiles");
const settingsPath = () => path.join(userData(), "settings.json");

const DEFAULT_SETTINGS = {
  mixedPort: DEFAULT_MIXED,
  controllerPort: DEFAULT_CTRL,
  secret: "veyra-secret",
  allowLan: false,
  logLevel: "info",
  autoTest: true,
  autoPick: true,
  autoTestIntervalSec: 300,
  subAutoUpdateMin: 0,
  closeToTray: true,
  startWithWindows: false,
  startMinimized: false,
  proxyBypass: "localhost;127.*;10.*;192.168.*;<local>",
  theme: "system",
  core: "mihomo",
  // —— Verge 对齐扩展 ——
  proxyMode: "system", // system | pac | off
  proxyGuard: false,
  disconnectOnProxyOff: true,
  bindAddress: "127.0.0.1",
  // TUN
  tunEnable: false,
  tunStack: "gvisor",
  tunAutoRoute: true,
  tunStrictRoute: false,
  tunAutoDetect: true,
  tunSniff: true,
  tunMtu: 9000,
  tunDevice: "Veyra",
  tunDnsHijack: ["any:53", "tcp://any:53"],
  serviceMode: false,
  // DNS
  dnsOverride: false,
  dnsEnable: true,
  dnsListen: "0.0.0.0:1053",
  dnsIpv6: false,
  dnsMode: "fake-ip",
  dnsFakeIpRange: "198.18.0.1/16",
  dnsFakeIpFilter: ["*.lan", "localhost", "*.local"],
  dnsNameserver: ["https://doh.pub/dns-query", "tls://dns.alidns.com"],
  dnsFallback: ["tls://1.1.1.1", "tls://8.8.8.8"],
  dnsDefaultNs: ["223.5.5.5", "119.29.29.29"],
  dnsHosts: {},
  // 热键 / 体验
  hotkeyToggleProxy: "Alt+P",
  hotkeyToggleWindow: "Alt+`",
  hotkeyModeRule: "Alt+R",
  hotkeyModeGlobal: "Alt+G",
  hotkeyModeDirect: "Alt+D",
  lightweightMode: false,
  locale: "zh",
  themeColor: "",
  customCss: "",
  // 备份
  webdavUrl: "",
  webdavUser: "",
  webdavPass: "",
  webdavRemote: "veyra-backup.zip",
  // 日志
  logMaxLines: 2000,
  logAutoCleanDays: 0,
  // 内核通道
  mihomoChannel: "stable", // stable | alpha
  // WebUI
  webuiPrefer: "metacubexd",
  unifiedDelay: true,
  tcpConcurrent: true,
  subRetry: 3,
  subTimeoutSec: 30,
  subUpdateViaProxy: true,
  windowBounds: null,
  portableMode: false,
  nodeSort: "delay", // delay | name | default
  trayGroupIcons: true,
  // 当前内核运行模式缓存（托盘菜单勾选态用；启动/切换后从 /configs 同步）
  coreMode: "rule", // rule | global | direct
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    appSettings = { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    appSettings = { ...DEFAULT_SETTINGS };
  }
  MIXED_PORT = Number(appSettings.mixedPort) || DEFAULT_MIXED;
  CONTROLLER = `127.0.0.1:${Number(appSettings.controllerPort) || DEFAULT_CTRL}`;
  SECRET = String(appSettings.secret || "veyra-secret");
  activeCore = appSettings.core === "singbox" ? "singbox" : "mihomo";
  return appSettings;
}

function saveSettings(patch = {}) {
  appSettings = { ...(appSettings || DEFAULT_SETTINGS), ...patch };
  fs.mkdirSync(userData(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(appSettings, null, 2), "utf8");
  if (patch.mixedPort != null) MIXED_PORT = Number(patch.mixedPort) || MIXED_PORT;
  if (patch.controllerPort != null) {
    CONTROLLER = `127.0.0.1:${Number(patch.controllerPort) || DEFAULT_CTRL}`;
  }
  if (patch.secret != null) SECRET = String(patch.secret);
  if (patch.core === "mihomo" || patch.core === "singbox") activeCore = patch.core;
  return appSettings;
}

function resourcesRoot() {
  // 打包后 extraResources 直接落在 process.resourcesPath 下（bin/icons/config）
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, "..", "resources");
}

function binPath() {
  const name = process.platform === "win32" ? "mihomo.exe" : "mihomo";
  return path.join(resourcesRoot(), "bin", name);
}

function sendProgress(phase, pct, label) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("core:progress", { phase, pct, label }); } catch {}
  }
}

// 系统通知：用于关键事件（内核崩溃、订阅下载失败、内核未找到）。
// 用户最小化到托盘时也能看到，不会错过。
function toastNotify(title, body) {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || "Veyra", body: body || "", silent: false });
      n.on("click", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
    }
  } catch {}
}

// ---- 双核管理：mihomo（默认） + sing-box（实验） ----
function coreBinPath(core) {
  if (core === "singbox") {
    const name = process.platform === "win32" ? "sing-box.exe" : "sing-box";
    return path.join(resourcesRoot(), "bin", name);
  }
  return binPath();
}

function coreKillName(core) {
  if (process.platform !== "win32") return null;
  return core === "singbox" ? "sing-box.exe" : "mihomo.exe";
}

function singboxConfig() {
  return path.join(configDir(), "singbox.json");
}

// sing-box 拉取不到 remote rule_set 会直接启动失败，且下载依赖代理（冷启动鸡生蛋问题）。
// 这里在构建配置时，用系统代理/自身代理把 .srs 预下成本地文件，改用 type:"local"，
// 让 sing-box 启动完全不依赖网络；下不到的集连同其规则一起剔除，保证一定能启动。
function rulesetsDir() {
  return path.join(configDir(), "rulesets");
}

function stripDroppedRuleSets(route, dropped) {
  const META = new Set(["action", "outbound", "rule_set"]);
  route.rules = (Array.isArray(route.rules) ? route.rules : [])
    .map((r) => {
      if (Array.isArray(r.rule_set)) {
        const kept = r.rule_set.filter((t) => !dropped.has(t));
        if (kept.length) r.rule_set = kept;
        else delete r.rule_set;
      }
      return r;
    })
    .filter((r) => Object.keys(r).some((k) => !META.has(k)));
}

async function materializeRuleSets(config) {
  const route = config && config.route;
  const sets = route && Array.isArray(route.rule_set) ? route.rule_set : null;
  if (!sets || !sets.length) return [];
  ensureDirs();
  fs.mkdirSync(rulesetsDir(), { recursive: true });
  const dropped = new Set();
  const next = [];
  for (const s of sets) {
    if (!s || !s.url || !s.tag) continue;
    const dest = path.join(rulesetsDir(), `${String(s.tag).replace(/[^\w.-]/g, "_")}.srs`);
    const have = fs.existsSync(dest) && fs.statSync(dest).size > 0;
    if (!have) {
      try {
        const { body } = await fetchSubscription(s.url);
        fs.writeFileSync(dest, body);
      } catch {
        dropped.add(s.tag);
        continue;
      }
    }
    next.push({ type: "local", tag: s.tag, format: s.format || "binary", path: dest });
  }
  route.rule_set = next;
  if (dropped.size) stripDroppedRuleSets(route, dropped);
  return [...dropped];
}

// 把当前生效的 Clash YAML 翻译成 sing-box 配置并落盘；订阅为空时生成直连保底，保证能启动
async function rebuildSingboxConfig() {
  sendProgress("singbox:build", 5, "正在解析 Clash 订阅…");
  ensureDirs();
  let clash = {};
  try {
    clash = getYaml().load(fs.readFileSync(runtimeConfig(), "utf8")) || {};
  } catch (e) {
    if (mainWindow) {
      mainWindow.webContents.send(
        "core:log",
        `[veyra] sing-box: 当前订阅解析失败，用直连保底启动：${e.message}\n`
      );
    }
  }
  if (!clash || typeof clash !== "object") clash = {};
  sendProgress("singbox:build", 25, "正在转换 Clash → sing-box…");
  const { config, warnings, stats } = convertClashToSingbox(clash, {
    mixedPort: MIXED_PORT,
    controllerHost: "127.0.0.1",
    controllerPort: Number(CONTROLLER.split(":")[1]) || 19097,
    secret: SECRET,
    allowLan: !!(appSettings && appSettings.allowLan),
    logLevel: (appSettings && appSettings.logLevel) || "info",
  });
  sendProgress("singbox:build", 55, "正在下载 rule-set 文件…");
  try {
    const dropped = await materializeRuleSets(config);
    if (dropped.length) {
      warnings.push(`以下规则集不可用已移除：${dropped.join("、")}`);
      stats.rules = Array.isArray(config.route?.rules) ? config.route.rules.length : stats.rules;
    }
  } catch {}
  sendProgress("singbox:build", 90, "正在写入 sing-box 配置…");
  fs.writeFileSync(singboxConfig(), JSON.stringify(config, null, 2), "utf8");
  sendProgress("singbox:build", 100, "sing-box 配置已就绪");
  if (mainWindow) {
    const lines = [
      `[veyra] sing-box 配置已生成：${stats.nodes} 节点 / ${stats.groups} 分组 / ${stats.rules} 规则\n`,
    ];
    for (const w of warnings.slice(0, 12)) lines.push(`[veyra] sing-box: ${w}\n`);
    if (warnings.length > 12) lines.push(`[veyra] sing-box: …还有 ${warnings.length - 12} 条已降级\n`);
    try {
      mainWindow.webContents.send("core:log", lines.join(""));
    } catch {}
  }
  return stats;
}

function portFree(port) {
  return new Promise((resolve) => {
    const net = require("net");
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPorts() {
  const preferMixed = Number(appSettings?.mixedPort) || DEFAULT_MIXED;
  const preferCtrl = Number(appSettings?.controllerPort) || DEFAULT_CTRL;
  MIXED_PORT = (await portFree(preferMixed)) ? preferMixed : preferMixed + 10003;
  const ctrlPort = (await portFree(preferCtrl)) ? preferCtrl : preferCtrl + 10003;
  CONTROLLER = `127.0.0.1:${ctrlPort}`;
  return { mixed: MIXED_PORT, controller: CONTROLLER };
}

function patchYamlKey(yaml, key, value) {
  const safeVal = /[:#[\]{}|>&*!?,@`]/.test(value) ? JSON.stringify(value) : value;
  const re = new RegExp(`^${key}:\\s*.+$`, "m");
  if (re.test(yaml)) return yaml.replace(re, `${key}: ${safeVal}`);
  return `${key}: ${safeVal}\n` + yaml;
}

function patchRuntimePorts() {
  let yaml = fs.readFileSync(runtimeConfig(), "utf8");
  const ctrlPort = CONTROLLER.split(":")[1];
  const allowLan = !!(appSettings && appSettings.allowLan);
  const logLevel = (appSettings && appSettings.logLevel) || "info";
  yaml = patchYamlKey(yaml, "mixed-port", String(MIXED_PORT));
  yaml = patchYamlKey(yaml, "external-controller", `127.0.0.1:${ctrlPort}`);
  yaml = patchYamlKey(yaml, "secret", SECRET);
  yaml = patchYamlKey(yaml, "allow-lan", allowLan ? "true" : "false");
  yaml = patchYamlKey(yaml, "log-level", logLevel);
  fs.writeFileSync(runtimeConfig(), yaml, "utf8");
}

function ensureDirs() {
  for (const d of [configDir(), profilesDir()]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(runtimeConfig())) {
    // 打包后默认配置在 extraResources 里（resources/config），开发态在项目 resources 下
    const def = path.join(resourcesRoot(), "config", "default.yaml");
    fs.copyFileSync(def, runtimeConfig());
  }
}

function guessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "subscription";
    return last.replace(/[^\w.\-一-龥]/g, "_").slice(0, 64) || "subscription.yaml";
  } catch {
    return `sub-${Date.now()}.yaml`;
  }
}

function looksLikeClashYaml(text) {
  return /(?:^|\n)\s*(?:proxies|proxy-groups|rules|mixed-port|port|socks-port)\s*:/m.test(text);
}

function normalizeSubscriptionBody(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (looksLikeClashYaml(trimmed)) return trimmed;

  // 常见：整段 Base64 的 Clash YAML
  try {
    const b64 = trimmed.replace(/\s+/g, "");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    if (looksLikeClashYaml(decoded)) return decoded;

    // 纯节点 URI 列表：转成 Clash YAML（很多机场返回这种格式）
    const lines = decoded
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(ss|ssr|vmess|vless|trojan|hysteria2?|tuic|wireguard):\/\//i.test(l));
    if (lines.length) {
      return uriImport.urisToYamlDoc(lines);
    }
  } catch (e) {
    if (e && e.message && /Clash YAML|原始节点/.test(e.message)) throw e;
  }

  // 某些机场直接返回带 BOM / 杂讯的 yaml
  if (trimmed.includes("proxies:") || trimmed.includes("proxy-groups:")) return trimmed;
  throw new Error("无法识别订阅格式（需要 Clash/mihomo YAML 或 Base64 YAML）");
}

function fetchWithPowershell(urlStr, proxyUrl, timeoutMs = 90000) {
  const tmp = path.join(app.getPath("temp"), `veyra-sub-${Date.now()}.bin`);
  const hdrTmp = `${tmp}.headers.json`;
  const proxyLine = proxyUrl
    ? `-Proxy '${proxyUrl.replace(/'/g, "''")}'`
    : "";
  const script = `
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
try {
  $resp = Invoke-WebRequest -Uri '${urlStr.replace(/'/g, "''")}' -OutFile '${tmp.replace(/'/g, "''")}' ${proxyLine} -Headers @{ 'User-Agent'='ClashMetaForAndroid/2.11.0' } -UseBasicParsing
  if (-not (Test-Path '${tmp.replace(/'/g, "''")}')) { throw 'empty file' }
  $h = @{}
  foreach ($k in $resp.Headers.Keys) { $h[$k] = ($resp.Headers[$k] -join ', ') }
  $h | ConvertTo-Json -Compress | Out-File -Encoding utf8 '${hdrTmp.replace(/'/g, "''")}'
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", script],
      { timeout: Math.max(5000, Number(timeoutMs) || 90000), windowsHide: true },
      (err, _stdout, stderr) => {
        const cleanup = () => {
          try { fs.unlinkSync(tmp); } catch {}
          try { fs.unlinkSync(hdrTmp); } catch {}
        };
        if (err) {
          cleanup();
          reject(new Error((stderr || err.message || "download failed").toString().trim().slice(0, 240)));
          return;
        }
        try {
          const body = fs.readFileSync(tmp);
          let headers = {};
          try { headers = JSON.parse(fs.readFileSync(hdrTmp, "utf8")); } catch {}
          cleanup();
          if (!body.length) reject(new Error("订阅内容为空"));
          else resolve({ body, headers });
        } catch (e) {
          cleanup();
          reject(e);
        }
      }
    );
  });
}

// 解析 Subscription-Userinfo 响应头: upload=..; download=..; total=..; expire=..
function parseSubscriptionUserinfo(headers = {}) {
  let raw = "";
  for (const k of Object.keys(headers)) {
    // 兼容机场放到对象存储元数据里的变体头（x-amz-meta- / x-obs-meta- 等，参考 clash-verge-rev）
    if (k.toLowerCase().endsWith("subscription-userinfo")) { raw = String(headers[k] || ""); break; }
  }
  if (!raw) return null;
  const m = {};
  raw.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx > 0) m[part.slice(0, idx).trim().toLowerCase()] = Number(part.slice(idx + 1).trim()) || 0;
  });
  if (!m.total || m.total <= 0) return null;
  return { upload: m.upload || 0, download: m.download || 0, total: m.total, expire: m.expire || 0 };
}

async function fetchSubscription(urlStr, opts = {}) {
  sendProgress("sub:download", 10, "正在下载订阅…");
  // 只用Veyra自身代理，失败再直连；不走任何第三方客户端端口
  const viaProxy = appSettings?.subUpdateViaProxy !== false;
  const proxies = viaProxy ? [`http://127.0.0.1:${MIXED_PORT}`, null] : [null, `http://127.0.0.1:${MIXED_PORT}`];
  let lastErr;
  for (const p of proxies) {
    try {
      const result = await fetchWithPowershell(urlStr, p, opts.timeoutMs);
      sendProgress("sub:download", 60, "订阅下载完成，正在解析…");
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("订阅下载失败");
}

function enhanceOpts() {
  const s = appSettings || DEFAULT_SETTINGS;
  return {
    mixedPort: MIXED_PORT,
    controllerPort: Number(CONTROLLER.split(":")[1]) || DEFAULT_CTRL,
    secret: SECRET,
    allowLan: !!s.allowLan,
    logLevel: s.logLevel || "info",
    bindAddress: s.bindAddress || "127.0.0.1",
    dnsOverride: !!s.dnsOverride,
    dnsConfig: vergeExt.buildDnsConfig(s),
    tunConfig: vergeExt.buildTunConfig(s),
    unifiedDelay: s.unifiedDelay !== false,
    tcpConcurrent: s.tcpConcurrent !== false,
  };
}

function detectPortable() {
  try {
    const exeDir = path.dirname(process.execPath);
    if (fs.existsSync(path.join(exeDir, "portable.txt")) || fs.existsSync(path.join(exeDir, "portable"))) {
      return path.join(exeDir, "data");
    }
  } catch {}
  return null;
}

const portableData = detectPortable();
if (portableData) {
  try {
    app.setPath("userData", portableData);
  } catch {}
}

function applyProxyGuardLoop() {
  vergeExt.stopProxyGuard();
  if (!(appSettings && appSettings.proxyGuard)) return;
  vergeExt.startProxyGuard({
    intervalMs: 4000,
    getDesired: () => {
      if (!appSettings?.proxyGuard) return null;
      if (appSettings.proxyMode === "off") return { enabled: false };
      return {
        enabled: true,
        mode: appSettings.proxyMode === "pac" ? "pac" : "system",
        mixedPort: MIXED_PORT,
        bypass: appSettings.proxyBypass || DEFAULT_SETTINGS.proxyBypass,
      };
    },
    apply: async (desired) => {
      if (!desired.enabled) return;
      const st = await systemProxyStatusRaw();
      if (desired.mode === "pac") {
        // PAC：只要 AutoConfigURL 丢了就恢复
        if (!st.pacUrl) await applyProxyMode("pac");
      } else if (!st.enabled || (st.server && !String(st.server).includes(String(MIXED_PORT)))) {
        await applyProxyMode("system");
      }
    },
  });
}

async function systemProxyStatusRaw() {
  if (process.platform !== "win32") return { enabled: false };
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile("reg", ["query", key], { windowsHide: true }, (err, stdout) =>
        err ? reject(err) : resolve({ stdout: String(stdout || "") })
      );
    });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(stdout);
    const sm = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    const pm = stdout.match(/AutoConfigURL\s+REG_SZ\s+(.+)/i);
    return {
      enabled,
      server: sm ? sm[1].trim() : "",
      pacUrl: pm ? pm[1].trim() : "",
    };
  } catch {
    return { enabled: false };
  }
}

async function applyProxyMode(mode) {
  const s = appSettings || DEFAULT_SETTINGS;
  const m = mode || s.proxyMode || "system";
  if (m === "off") {
    const r = await vergeExt.setWinProxyMode({
      mode: "off",
      mixedPort: MIXED_PORT,
      bypass: s.proxyBypass,
      regAdd,
      refreshWinInet,
    });
    sysProxyOn = false;
    if (s.disconnectOnProxyOff) {
      try {
        await api("/connections", "DELETE");
      } catch {}
    }
    saveSettings({ proxyMode: "off" });
    updateTray();
    notifySysProxy();
    return r;
  }
  const r = await vergeExt.setWinProxyMode({
    mode: m === "pac" ? "pac" : "system",
    mixedPort: MIXED_PORT,
    bypass: s.proxyBypass || DEFAULT_SETTINGS.proxyBypass,
    regAdd,
    refreshWinInet,
  });
  sysProxyOn = true;
  saveSettings({ proxyMode: m === "pac" ? "pac" : "system" });
  updateTray();
  notifySysProxy();
  return r;
}

// 内核代理模式：统一入口，同时缓存到设置里供托盘菜单显示勾选态
async function setCoreMode(mode, { notify = false } = {}) {
  const m = mode === "global" || mode === "direct" ? mode : "rule";
  saveSettings({ coreMode: m });
  if (notify) updateTray();
  return api("/configs", "PATCH", { mode: m });
}

function registerHotkeys() {
  try {
    globalShortcut.unregisterAll();
  } catch {}
  const s = appSettings || DEFAULT_SETTINGS;
  const bind = (accel, fn) => {
    if (!accel || !String(accel).trim()) return;
    try {
      globalShortcut.register(String(accel).trim(), fn);
    } catch {}
  };
  bind(s.hotkeyToggleProxy, async () => {
    try {
      if (sysProxyOn) await applyProxyMode("off");
      else await applyProxyMode(s.proxyMode === "pac" ? "pac" : "system");
    } catch {}
  });
  bind(s.hotkeyToggleWindow, () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  bind(s.hotkeyModeRule, () => {
    setCoreMode("rule", { notify: true }).catch(() => {});
  });
  bind(s.hotkeyModeGlobal, () => {
    setCoreMode("global", { notify: true }).catch(() => {});
  });
  bind(s.hotkeyModeDirect, () => {
    setCoreMode("direct", { notify: true }).catch(() => {});
  });
}

function setLightweight(on) {
  saveSettings({ lightweightMode: !!on });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (on) {
    // Verge 语义：收起主窗口到托盘，降低渲染占用
    mainWindow.hide();
    if (mainWindow.webContents) {
      try {
        mainWindow.webContents.setBackgroundThrottling(true);
      } catch {}
    }
    trayBalloon("轻量模式", "主窗口已收起，托盘继续工作");
  } else {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setOpacity(1);
    mainWindow.setMinimumSize(960, 640);
    try {
      mainWindow.webContents.setBackgroundThrottling(false);
    } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:lightweight", { on: !!on });
  }
  updateTray();
}

async function reloadRuntimeConfig() {
  // 内核运行中时首选端口被自身占用，pickPorts 必判 false 而把端口漂移到 +10003，
  // 随后 api() 打到死端口 → 落入 catch 强制全量重启并清掉系统代理。
  // 故仅在内核未运行时才挑端口；运行中沿用现端口，让 mihomo 走真正的热重载。
  const wasRunning = !!(coreProc || coreOnline);
  if (!wasRunning) {
    await pickPorts();
  }
  // enhance 已写端口；再补丁一次防漂移
  patchRuntimePorts();
  if (activeCore === "singbox") {
    const wasProxy = sysProxyOn;
    if (wasRunning) {
      await stopCore({ clearProxy: true });
      await startCore();
      if (wasProxy) await setSystemProxy(true);
    }
    return;
  }
  if (wasRunning) {
    try {
      await api("/configs?force=true", "PUT", { path: runtimeConfig() });
    } catch {
      // 热重载失败需重启：保留系统代理并在重启后恢复，避免断流后代理被静默关闭
      const wasProxy = sysProxyOn;
      await stopCore({ clearProxy: false });
      await startCore();
      if (wasProxy) await setSystemProxy(true);
    }
  }
  // 内核未运行时保持停止：更新订阅/切换配置不得自动拉起服务（用户显式启停为准）
}

async function runEnhanceAndReload() {
  ensureDirs();
  profilesLib.migrateLegacyFiles(profilesDir());
  const r = enhanceAndWrite(profilesDir(), runtimeConfig(), enhanceOpts());
  await reloadRuntimeConfig();
  return r;
}

async function applyProfileContent(name, content, kind = "local", url = null) {
  ensureDirs();
  profilesLib.migrateLegacyFiles(profilesDir());
  // 远程订阅按 URL 原地覆盖已有档案并清理重复项；首次导入才新建
  const item = (kind === "remote" && url ? profilesLib.updateRemoteByUrl(profilesDir(), url, content) : null)
    || profilesLib.importLocal(profilesDir(), name, content, kind, url);
  const er = await runEnhanceAndReload();
  return {
    ok: true,
    path: path.join(profilesDir(), item.file),
    uid: item.uid,
    mixedPort: MIXED_PORT,
    controller: CONTROLLER,
    warnings: er.warnings,
    scriptLogs: er.scriptLogs,
  };
}

function api(pathname, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const [host, port] = CONTROLLER.split(":");
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host,
        port: Number(port),
        path: pathname,
        method,
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: 4000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null });
          } catch {
            resolve({ status: res.statusCode, data: text });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function waitController(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await api("/version");
      if (r.status === 200) return r.data;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("mihomo controller not ready");
}

/** 从内核读取当前 mode 并缓存，供托盘菜单显示正确的勾选态（失败静默） */
async function syncCoreModeFromApi() {
  try {
    const cfg = await api("/configs");
    const mode = cfg && cfg.data && cfg.data.mode;
    if (mode === "rule" || mode === "global" || mode === "direct") saveSettings({ coreMode: mode });
  } catch {}
}

async function detectOtherProxy() {
  const conflicts = [];
  // 常见代理软件端口
  const commonPorts = [
    [7890, "Clash/Verge"],
    [7891, "Clash"],
    [9090, "Clash 控制端"],
    [10808, "v2rayN"],
    [10809, "v2rayN"],
    [1080, "SOCKS 代理"],
  ];
  const net = require("net");
  for (const [port, label] of commonPorts) {
    // 跳过我们自己的端口
    if (port === MIXED_PORT) continue;
    const inUse = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.end(); resolve(true); });
      s.on("error", () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 800);
    });
    if (inUse) conflicts.push(`${label} (端口 ${port} 被占用)`);
  }
  return conflicts;
}

async function startCore() {
  const bin = coreBinPath(activeCore);
  const coreLabel = activeCore === "singbox" ? "sing-box" : "mihomo";
  if (!fs.existsSync(bin)) {
    toastNotify("内核未找到", `${coreLabel} 未安装，请到设置 → 代理服务 里下载`);
    throw new Error(`内核(${coreLabel})未找到: ${bin}，请到 设置 → 代理服务 里下载/切换内核`);
  }
  // 已有本进程拉起的内核，或外部已占用我们的 controller。
  // 注意：controller 端口可能被其它 Clash/mihomo 占用，此时探活成功不代表是我们的内核，
  // 仅做收养(adopt)并如实提示，不再静默当成自己人，否则托盘/界面显示已连接却管不动。
  try {
    const ver = await api("/version");
    if (ver.status === 200) {
      setCoreOnline(true, { version: ver.data });
      await syncCoreModeFromApi();
      // 收养路径：内核是外部进程，本进程不知道它是否开着系统代理。
      // 主动读一次注册表同步 sysProxyOn 变量，否则 UI orb 变绿但托盘/开关状态飘移。
      await syncSystemProxyState();
      if (!coreProc && mainWindow) {
        const proxyHint = sysProxyOn ? "系统代理已生效" : "系统代理未生效（需手动开启）";
        mainWindow.webContents.send(
          "core:log",
          `[veyra] controller ${CONTROLLER} 已有响应，收养为运行态（非本进程拉起，PID 未知，${proxyHint}）。如非 Veyra 内核请更换控制端口。\n`
        );
      }
      return { already: true, version: ver.data };
    }
  } catch {}

  if (coreProc) return { already: true };

  ensureDirs();
  await pickPorts();
  // sing-box 每次启动前重建配置（端口可能漂移 + 订阅可能已变）；mihomo 沿用旧的打端口补丁
  if (activeCore === "singbox") await rebuildSingboxConfig();
  else patchRuntimePorts();
  const preferMixed = Number(appSettings?.mixedPort) || DEFAULT_MIXED;
  if (MIXED_PORT !== preferMixed && mainWindow) {
    mainWindow.webContents.send(
      "core:log",
      `[veyra] 端口 ${preferMixed} 被占用，临时使用 ${MIXED_PORT}\n`
    );
  }
  const coreArgs =
    activeCore === "singbox"
      ? ["run", "-c", singboxConfig(), "-D", configDir()]
      : ["-d", configDir(), "-f", runtimeConfig()];
  coreProc = spawn(bin, coreArgs, {
    cwd: configDir(),
    windowsHide: true,
  });
  const spawned = coreProc;
  const onData = (buf) => {
    const line = buf.toString();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("core:log", line);
  };
  coreProc.stdout?.on("data", onData);
  coreProc.stderr?.on("data", onData);
  // spawn 失败（无执行权限/被杀软拦截/二进制损坏）若无监听会抛未捕获异常致主进程崩溃
  coreProc.on("error", (err) => {
    if (coreProc === spawned) coreProc = null;
    setCoreOnline(false, { code: -1, error: String((err && err.message) || err) });
  });
  coreProc.on("exit", (code) => {
    // 仅当退出的是当前内核时才清理：stop→start 重启序列里旧进程 exit 事件可能迟到，
    // 不校验会误清新内核 coreProc 引用、并清掉刚恢复的系统代理。
    if (coreProc !== spawned) return;
    coreProc = null;
    // 进程异常退出时清掉我们留下的系统代理，避免指向死端口
    clearOurSystemProxy()
      .catch(() => {})
      .finally(() => setCoreOnline(false, { code }));
  });

  try {
    const ver = await waitController();
    setCoreOnline(true, { version: ver });
    await syncCoreModeFromApi();
    return { version: ver };
  } catch (e) {
    await stopCore({ clearProxy: true });
    throw new Error(`内核启动失败（端口可能被占用）。请检查设置中的端口后重试。${e.message || ""}`);
  }
}

async function stopCore(opts = {}) {
  if (stoppingCore) return stoppingCore;
  stoppingCore = _doStopCore(opts).finally(() => { stoppingCore = null; });
  return stoppingCore;
}

async function _doStopCore(opts = {}) {
  const clearProxy = opts.clearProxy !== false;
  if (clearProxy) {
    await clearOurSystemProxy();
  }
  if (!coreProc) {
    // 内核可能由上一个实例遗留：coreProc 为空，但我们的 controller 端口仍然活着。
    // 这种情况只把状态置为「未连接」是不够的——内核还在跑、系统代理还指向它，
    // 会出现「界面显示未连接、实际流量仍在走代理」的不同步。按镜像名结束我们自己的内核。
    let alive = false;
    try {
      const ver = await api("/version");
      alive = ver.status === 200;
    } catch {}
    if (alive) {
      const img = coreKillName(activeCore) || "mihomo.exe";
      await new Promise((r) => {
        try {
          execFile("taskkill", ["/IM", img, "/F", "/T"], () => r());
        } catch {
          r();
        }
      });
      // 留一点时间让端口释放，避免下一次 startCore 误判成「已被占用」
      await new Promise((r) => setTimeout(r, 300));
    }
    setCoreOnline(false);
    return;
  }
  return new Promise((resolve) => {
    const p = coreProc;
    coreProc = null;
    coreMemCache = { mb: 0, t: 0 };
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      setCoreOnline(false);
      resolve();
    };
    p.once("exit", done);
    if (process.platform === "win32") {
      try {
        execFile("taskkill", ["/pid", String(p.pid), "/f", "/t"], () => done());
      } catch {
        done();
      }
    } else {
      p.kill("SIGTERM");
      setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {}
        done();
      }, 2000);
    }
  });
}

function regAdd(args) {
  return new Promise((resolve) => {
    // execFile 在受限环境会同步抛 EPERM，必须包住，否则 Promise 直接 reject 会中断启动链
    try {
      execFile("reg", args, () => resolve());
    } catch {
      resolve();
    }
  });
}

function regQuery(args) {
  return new Promise((resolve) => {
    try {
      execFile("reg", args, { encoding: "utf8" }, (err, stdout) => {
        resolve(err ? "" : String(stdout || ""));
      });
    } catch {
      resolve("");
    }
  });
}

function notifySysProxy() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("system:proxyChanged", { enabled: !!sysProxyOn });
  }
}

function refreshWinInet() {
  if (process.platform !== "win32") return Promise.resolve();
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class VeyraWinInet {
  [DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
'@
[void][VeyraWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][VeyraWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`;
  return new Promise((resolve) => {
    try {
      execFile("powershell", ["-NoProfile", "-Command", script], { timeout: 8000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function getSystemProxyStatus() {
  if (process.platform !== "win32") return { enabled: false, server: "", ours: false };
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const enableOut = await regQuery(["query", key, "/v", "ProxyEnable"]);
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOut);
  const serverOut = await regQuery(["query", key, "/v", "ProxyServer"]);
  const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
  const server = m ? m[1].trim() : "";
  // 严格判定：注册表必须精确指向当前 MIXED_PORT，才算 Veyra 接管。
  // 旧逻辑把 DEFAULT_MIXED / 设置端口都算 ours，端口漂移(+10003)后旧注册表指向死端口也会误判为开。
  let ours = false;
  if (enabled && server) {
    const re = /(?:127\.0\.0\.1|localhost)\s*:\s*(\d+)/gi;
    let hit;
    while ((hit = re.exec(server)) !== null) {
      if (Number(hit[1]) === Number(MIXED_PORT)) {
        ours = true;
        break;
      }
    }
  }
  return { enabled, server, ours };
}

async function syncSystemProxyState() {
  const st = await getSystemProxyStatus();
  // ours 只匹配当前 MIXED_PORT；收养路径下孤儿内核可能用历史/漂移端口跑，
  // 额外用 isOurProxyServer 兜底（覆盖 DEFAULT_MIXED + 漂移 +10003 的情况）。
  sysProxyOn = !!st.ours || (st.enabled && isOurProxyServer(st.server));
  updateTray();
  notifySysProxy();
  return st;
}

/** 判断注册表里的代理服务器地址是否指向 Veyra 自己的端口（含历史/漂移端口） */
function isOurProxyServer(server) {
  const prefer = Number(appSettings?.mixedPort) || DEFAULT_MIXED;
  const ports = new Set([MIXED_PORT, DEFAULT_MIXED, prefer, DEFAULT_MIXED + 10003, prefer + 10003].map(Number));
  const re = /(?:127\.0\.0\.1|localhost)\s*:\s*(\d+)/gi;
  let hit;
  while ((hit = re.exec(String(server || ""))) !== null) {
    if (ports.has(Number(hit[1]))) return true;
  }
  return false;
}

/** 仅关闭指向本机Veyra端口的系统代理，不误伤其它代理软件 */
async function clearOurSystemProxy() {
  const st = await getSystemProxyStatus();
  // PAC 模式下 ProxyEnable=0，故 ours / st.enabled 恒为 false，但 AutoConfigURL 仍指向本地 PAC；
  // 用 systemProxyStatusRaw 的 pacUrl 兜底识别（指向 127.0.0.1/localhost 的 PAC 即视为我们留下），
  // 否则 PAC 模式退出后 AutoConfigURL 残留指向死 PAC 服务器，浏览器/系统联网异常。
  let ourPac = false;
  if (sysProxyOn && !st.enabled) {
    const raw = await systemProxyStatusRaw();
    ourPac = !!raw.pacUrl && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(raw.pacUrl.trim());
  }
  // sysProxyOn 只代表「本软件曾在管」，注册表端口必须仍属于我们才动手清理；
  // 否则会把用户其它代理软件（如 127.0.0.1:7890）的代理配置一并关掉。
  if (st.ours || (sysProxyOn && st.enabled && isOurProxyServer(st.server)) || ourPac) {
    return setSystemProxy(false);
  }
  if (sysProxyOn) {
    sysProxyOn = false;
    updateTray();
    notifySysProxy();
  }
  return { ok: true, enabled: false, skipped: true };
}

async function setSystemProxyDarwin(enable) {
  // macOS：networksetup 设置 Web/Secure Web Proxy
  const services = await new Promise((resolve) => {
    execFile("networksetup", ["-listallnetworkservices"], (err, stdout) => {
      if (err) resolve([]);
      else
        resolve(
          String(stdout)
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith("*") && !/^\d+\.\d+/.test(s))
        );
    });
  });
  for (const svc of services.slice(0, 8)) {
    if (enable) {
      await runQuiet("networksetup", ["-setwebproxy", svc, "127.0.0.1", String(MIXED_PORT)]);
      await runQuiet("networksetup", ["-setsecurewebproxy", svc, "127.0.0.1", String(MIXED_PORT)]);
      await runQuiet("networksetup", ["-setwebproxystate", svc, "on"]);
      await runQuiet("networksetup", ["-setsecurewebproxystate", svc, "on"]);
    } else {
      await runQuiet("networksetup", ["-setwebproxystate", svc, "off"]);
      await runQuiet("networksetup", ["-setsecurewebproxystate", svc, "off"]);
    }
  }
  sysProxyOn = !!enable;
  updateTray();
  notifySysProxy();
  return { ok: true, enabled: !!enable, platform: "darwin" };
}

function runQuiet(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, () => resolve());
  });
}

async function setSystemProxyLinux(enable) {
  // GNOME
  if (enable) {
    await runQuiet("gsettings", ["set", "org.gnome.system.proxy", "mode", "manual"]);
    await runQuiet("gsettings", ["set", "org.gnome.system.proxy.http", "host", "127.0.0.1"]);
    await runQuiet("gsettings", ["set", "org.gnome.system.proxy.http", "port", String(MIXED_PORT)]);
    await runQuiet("gsettings", ["set", "org.gnome.system.proxy.https", "host", "127.0.0.1"]);
    await runQuiet("gsettings", ["set", "org.gnome.system.proxy.https", "port", String(MIXED_PORT)]);
  } else {
    await runQuiet("gsettings", ["set", "org.gnome.system.proxy", "mode", "none"]);
  }
  sysProxyOn = !!enable;
  updateTray();
  notifySysProxy();
  return { ok: true, enabled: !!enable, platform: "linux" };
}

async function setSystemProxy(enable) {
  if (process.platform === "darwin") return setSystemProxyDarwin(enable);
  if (process.platform === "linux") return setSystemProxyLinux(enable);
  if (process.platform !== "win32") return { ok: false, reason: "unsupported" };
  if (!enable) {
    const r = await applyProxyMode("off");
    return { ok: true, enabled: false, ...r };
  }
  const mode = (appSettings && appSettings.proxyMode === "pac") ? "pac" : "system";
  const r = await applyProxyMode(mode);
  return { ok: true, enabled: true, ...r };
}

function coreInfo() {
  const bin = binPath();
  let size = 0;
  let mtime = null;
  if (fs.existsSync(bin)) {
    const st = fs.statSync(bin);
    size = st.size;
    mtime = st.mtimeMs;
  }
  let fileVersion = null;
  if (fs.existsSync(bin)) {
    try {
      fileVersion = execFileSync(bin, ["-v"], { encoding: "utf8", timeout: 5000 }).trim();
    } catch {
      fileVersion = null;
    }
  }
  // 构建类型只能下载时记录（mihomo 的 -v 输出里区分不出标准版/兼容版）
  let buildAsset = "";
  try {
    buildAsset = fs
      .readFileSync(
        path.join(path.dirname(bin), activeCore === "singbox" ? "core-singbox.txt" : "core-mihomo.txt"),
        "utf8"
      )
      .split("\n")[0]
      .trim();
  } catch {}
  const build =
    activeCore === "singbox"
      ? buildAsset
        ? "singbox"
        : "unknown"
      : /compatible/i.test(buildAsset)
        ? "compatible"
        : buildAsset
          ? "standard"
          : "unknown";
  let cpu = "";
  let cpuCount = 0;
  try {
    const cpus = os.cpus();
    cpuCount = cpus.length;
    cpu = ((cpus[0] && cpus[0].model) || "").trim();
  } catch {}
  return {
    path: bin,
    exists: fs.existsSync(bin),
    size,
    mtime,
    fileVersion,
    build,
    buildAsset,
    cpu,
    cpuCount,
    arch: process.arch,
    core: activeCore,
    pid: coreProc?.pid || null,
    // running 以 controller 可达性(coreOnline)为准，而非仅 coreProc：
    // 收养的外部/遗留内核 coreProc 为空但确实在跑，不能显示未连接。
    running: !!coreProc || !!coreOnline,
    mixedPort: MIXED_PORT,
    controller: CONTROLLER,
    secret: SECRET,
  };
}

async function checkCoreUpdate(core = activeCore) {
  const repo = core === "singbox" ? "SagerNet/sing-box" : "MetaCubeX/mihomo";
  const channel = (appSettings && appSettings.mihomoChannel) || "stable";
  const tmp = path.join(app.getPath("temp"), `veyra-ver-${Date.now()}.json`);
  const url =
    core !== "singbox" && channel === "alpha"
      ? `https://api.github.com/repos/${repo}/releases?per_page=15`
      : `https://api.github.com/repos/${repo}/releases/latest`;
  const script =
    core !== "singbox" && channel === "alpha"
      ? `
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$r = Invoke-WebRequest -Uri '${url}' -OutFile '${tmp.replace(/'/g, "''")}' -Headers @{ 'User-Agent'='veyra' } -UseBasicParsing
`
      : `
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri '${url}' -OutFile '${tmp.replace(/'/g, "''")}' -Headers @{ 'User-Agent'='veyra' } -UseBasicParsing
`;
  await new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-Command", script], { timeout: 60000 }, (err) =>
      err ? reject(err) : resolve()
    );
  });
  let data = JSON.parse(fs.readFileSync(tmp, "utf8"));
  try {
    fs.unlinkSync(tmp);
  } catch {}
  if (Array.isArray(data)) {
    data = data.find((x) => x.prerelease) || data[0] || {};
  }
  return {
    latest: data.tag_name,
    name: data.name,
    url: data.html_url,
    channel: core === "mihomo" ? channel : "stable",
  };
}

async function updateCoreBinary(core = activeCore) {
  const label = core === "singbox" ? "sing-box" : "mihomo";
  // 只停正在跑的核：更新非当前核时只下载不动服务。
  // 注意含「收养的遗留内核」场景：coreProc 为空但 controller 可达，也必须先停，
  // 否则 Windows 下二进制被占用，删除/替换会静默失败，用户以为更新了实际还是旧版。
  const isActive = core === activeCore;
  const wasRunning = isActive && (!!coreProc || !!coreOnline);
  const wasProxy = isActive && sysProxyOn;
  if (wasRunning) await stopCore({ clearProxy: true });
  const scriptName = core === "singbox" ? "download-singbox.mjs" : "download-mihomo.mjs";
  const bin = coreBinPath(core);
  // 打包后 scripts 不在 asar 内（由 electron-builder 复制到 resources/scripts），
  // 且 cwd 不能指向 asar 文件（chdir 会 ENOTDIR），因此这里按候选路径解析并以其所在目录为 cwd。
  const scriptCandidates = [
    path.join(resourcesRoot(), "scripts", scriptName),
    path.join(__dirname, "..", "scripts", scriptName),
  ];
  const script = scriptCandidates.find((p) => fs.existsSync(p)) || scriptCandidates[1];
  const bak = `${bin}.bak`;
  // 备份旧二进制：下载脚本要先看到目标不存在才会重新下载（存在即跳过），
  // 因此必须先移走旧文件；失败时用备份回滚，避免「更新失败 = 内核丢失」。
  let hadBin = false;
  if (fs.existsSync(bin)) {
    try {
      fs.copyFileSync(bin, bak);
      hadBin = true;
    } catch {}
    try {
      fs.unlinkSync(bin);
    } catch {
      // 句柄释放有延迟，稍等重试一次；仍失败则明确报错（否则脚本会因文件存在直接跳过）
      await new Promise((r) => setTimeout(r, 600));
      try {
        fs.unlinkSync(bin);
      } catch (e2) {
        if (hadBin) {
          try { fs.unlinkSync(bak); } catch {}
        }
        if (wasRunning) {
          try { await startCore(); if (wasProxy) await setSystemProxy(true); } catch {}
        }
        throw new Error(`${label} 内核正在使用中，无法替换（${e2.message || e2}）。请先停止代理服务后重试。`);
      }
    }
  }
  // 构建记录一起清掉，下载脚本会重新匹配并重写
  try {
    fs.unlinkSync(
      path.join(path.dirname(bin), core === "singbox" ? "core-singbox.txt" : "core-mihomo.txt")
    );
  } catch {}
  const channel = (appSettings && appSettings.mihomoChannel) || "stable";
  const env = {
    ...process.env,
    MIHOMO_CHANNEL: core === "mihomo" ? channel : "stable",
    // 明确告诉脚本把内核写到 coreBinPath 所在目录（打包后脚本位置与 bin 目录不再相邻）
    VEYRA_BIN_DIR: path.dirname(bin),
  };
  let nodeBin = "node";
  try {
    execFileSync("node", ["--version"], { stdio: "pipe", timeout: 5000 });
  } catch {
    // PATH 里没有 node 时用 Electron 自带的 Node 运行下载脚本。
    // 必须带 ELECTRON_RUN_AS_NODE=1，否则会以 GUI 模式启动 Electron 导致进程挂起、
    // execFileSync 永久阻塞主进程（应用整体卡死）。
    nodeBin = process.execPath;
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  const restore = async () => {
    if (hadBin && !fs.existsSync(bin)) {
      try { fs.renameSync(bak, bin); } catch {}
    }
    try { fs.unlinkSync(bak); } catch {}
  };
  try {
    execFileSync(nodeBin, [script], {
      cwd: path.dirname(script),
      stdio: "pipe",
      env,
      timeout: 300000,
    });
  } catch (e) {
    const out = String(e.stdout || "") + String(e.stderr || "") + String(e.message || "");
    // 取最后 300 字，避免超长
    const tail = out.slice(-300).replace(/\s+/g, " ").trim();
    await restore();
    if (wasRunning) {
      try { await startCore(); if (wasProxy) await setSystemProxy(true); } catch {}
    }
    throw new Error(`${label} 内核下载失败：${tail || "未知错误（node 执行失败）"}`);
  }
  if (!fs.existsSync(bin)) {
    await restore();
    if (wasRunning) {
      try { await startCore(); if (wasProxy) await setSystemProxy(true); } catch {}
    }
    throw new Error(`${label} 内核下载失败，文件不存在`);
  }
  try { fs.unlinkSync(bak); } catch {}
  coreVerCache.clear();
  if (wasRunning) {
    await startCore();
    if (wasProxy) await setSystemProxy(true);
  }
  return coreInfo();
}

// 单个内核的安装/版本（调二进制自身，不要求服务在线）。
// execFileSync 是同步阻塞调用，设置页每次 reload 都调两次会让主进程明显卡顿；
// 这里按二进制 mtime + 60s TTL 缓存，版本更新后 mtime 变化会自然失效。
const coreVerCache = new Map(); // core -> { t, mtime, val }
function coreVersionInfo(core) {
  const bin = coreBinPath(core);
  if (!fs.existsSync(bin)) {
    coreVerCache.delete(core);
    return { installed: false, version: "" };
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(bin).mtimeMs;
  } catch {}
  const cached = coreVerCache.get(core);
  if (cached && cached.mtime === mtime && Date.now() - cached.t < 60000) return cached.val;
  let val;
  try {
    const args = core === "singbox" ? ["version"] : ["-v"];
    const out = execFileSync(bin, args, { encoding: "utf8", timeout: 8000 }).trim();
    const m = out.match(/(\d+\.\d+[.\d]*)/);
    val = { installed: true, version: m ? m[1] : out.split("\n")[0].slice(0, 64) };
  } catch {
    val = { installed: true, version: "" };
  }
  coreVerCache.set(core, { t: Date.now(), mtime, val });
  return val;
}

function coreList() {
  return {
    active: activeCore,
    mihomo: coreVersionInfo("mihomo"),
    singbox: coreVersionInfo("singbox"),
  };
}

// 切换内核：停旧核 → 记设置 → 缺二进制就按需下载 → 按需重启
async function switchCore(next) {
  if (next !== "mihomo" && next !== "singbox") throw new Error(`未知内核：${next}`);
  if (next === activeCore) return { core: activeCore, info: coreInfo() };
  const label = next === "singbox" ? "sing-box" : "mihomo";
  const wasRunning = !!coreProc || coreOnline;
  const wasProxy = sysProxyOn;
  await stopCore({ clearProxy: true });
  saveSettings({ core: next });
  if (mainWindow) mainWindow.webContents.send("core:log", `[veyra] 切换内核 → ${label}\n`);
  if (!fs.existsSync(coreBinPath(next))) {
    if (mainWindow) {
      mainWindow.webContents.send("core:log", `[veyra] 正在按需下载 ${label} 内核…\n`);
    }
    try {
      await updateCoreBinary(next);
    } catch (e) {
      throw new Error(`${label} 内核下载失败：${e.message || e}`);
    }
  }
  updateTray();
  if (wasRunning) {
    await startCore();
    if (wasProxy) await setSystemProxy(true);
  }
  return { core: activeCore, info: coreInfo() };
}

function appIconPath() {
  const ico = path.join(resourcesRoot(), "icons", "icon.ico");
  const png = path.join(resourcesRoot(), "icons", "icon-256.png");
  if (process.platform === "win32" && fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return null;
}

function createWindow() {
  const icon = appIconPath();
  // 窗口尺寸按屏幕工作区自适应，保证完整落在桌面内（不被任务栏 / 屏幕边缘裁切）
  // v1.1.4：默认档位对齐 Clash Verge 的窗口观感（Clash Verge 默认内容区约 1142×822、含边框约 1144×854），
  // 取 1200×860 作为启动默认——与 Clash Verge 同一观感档位、略舒展一档；
  // 宽高均不锁死，可自由缩放；历史过小的 windowBounds 存档会被抬升到新目标，避免启动即小窗。
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const saved = appSettings && appSettings.windowBounds;
  const TARGET_W = Math.min(1200, Math.max(1144, wa.width - 60));
  const TARGET_H = Math.min(860, Math.max(800, wa.height - 60));
  let winW = TARGET_W;
  let winH = TARGET_H;
  if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    winW = Math.max(saved.width, TARGET_W);
    winH = Math.max(saved.height, TARGET_H);
  }
  // 兜底：确保窗口不超出工作区
  winW = Math.min(winW, wa.width - 40);
  winH = Math.min(winH, wa.height - 40);
  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 980,
    minHeight: 640,
    x: typeof saved?.x === "number" ? saved.x : undefined,
    y: typeof saved?.y === "number" ? saved.y : undefined,
    useContentSize: false,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    frame: false,
    titleBarStyle: "hidden",
    // 透明窗口 + 渲染层 .app 的 border-radius：让无边框窗口在 Windows 上也呈现圆角，
    // 而不是一块直角砖。背景色必须全透明，否则四角会露出底色方块。
    transparent: true,
    backgroundColor: "#00000000",
    show: !(appSettings && appSettings.lightweightMode),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 宽高均可自由缩放：最小 980×640（渲染层 .app 最小 880×560 之上留足裕量），最大不超过屏幕工作区
  mainWindow.setMinimumSize(980, 640);
  mainWindow.setMaximumSize(Math.max(1500, wa.width), Math.max(900, wa.height - 40));

  if (icon) {
    try {
      mainWindow.setIcon(icon);
    } catch {}
  }

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // 拖动/缩放窗口会以每帧频率触发 resize/move；直接同步写 settings.json 会造成
  // 高频磁盘 IO（拖动一次可能写几十次）。这里合并 400ms 内的连续事件，只落盘一次。
  let boundsTimer = null;
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        saveSettings({ windowBounds: mainWindow.getBounds() });
      } catch {}
    }, 400);
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);

  mainWindow.on("closed", () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    mainWindow = null;
  });

  // 页面加载完成 / 窗口重新显示时补推一次状态：启动期推送可能因渲染层尚未挂载而丢失，
  // 窗口长时间隐藏后也需要一次强制对齐，保证界面与托盘永远同源同时。
  const pushStateNow = () => {
    sendStatus();
    syncSystemProxyState().catch(() => {});
  };
  mainWindow.webContents.on("did-finish-load", pushStateNow);
  mainWindow.on("show", pushStateNow);
}

function iconsDir() {
  return path.join(resourcesRoot(), "icons");
}

function loadTrayImage(connected) {
  const dir = iconsDir();
  const style = connected ? "on" : "off";

  // Windows 托盘的槽位尺寸固定。直接交给系统缩小 48–128px 图片会丢失边缘和五官细节；
  // 按显示器 DPI 读取已为对应尺寸锐化的素材，避免二次下采样造成图标发糊、显小。
  if (process.platform === "win32") {
    const dpi = screen.getPrimaryDisplay().scaleFactor || 1;
    const candidates = [
      dpi >= 2 ? `tray-win-${style}@2x.png` : null,
      dpi >= 1.75 ? `tray-win-${style}-128.png` : null,
      dpi >= 1.5 ? `tray-win-${style}-24.png` : null,
      dpi >= 1.25 ? `tray-win-${style}-20.png` : null,
      `tray-win-${style}.png`,
      // 兼容旧版资源包：缺少小尺寸文件时再回退到大图。
      `tray-win-${style}-48.png`,
      `tray-win-${style}-64.png`,
      `tray-win-${style}-128.png`,
    ].filter(Boolean);
    for (const f of candidates) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          img.setTemplateImage(false);
          return img;
        }
      } catch {}
    }
    // 兜底：回退到旧版 tray 图标
    for (const f of [`tray-${style}@2x.png`, `tray-${style}.png`, "tray.png", "icon-32.png"]) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          img.setTemplateImage(false);
          return img;
        }
      } catch {}
    }
    return nativeImage.createEmpty();
  }

  // macOS / Linux：保留 addRepresentation 多 DPI 支持
  const specs = [
    { scaleFactor: 1, size: 16, file: `tray-${style}.png` },
    { scaleFactor: 1.25, size: 20, file: `tray-${style}-20.png` },
    { scaleFactor: 1.5, size: 24, file: `tray-${style}-24.png` },
    { scaleFactor: 2, size: 32, file: `tray-${style}@2x.png` },
  ];
  const basePath = path.join(dir, specs[0].file);
  if (!fs.existsSync(basePath)) {
    for (const f of ["tray.png", "tray-off.png", "icon-32.png"]) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
    return nativeImage.createEmpty();
  }
  const img = nativeImage.createFromPath(basePath);
  for (const s of specs.slice(1)) {
    const p = path.join(dir, s.file);
    if (!fs.existsSync(p)) continue;
    try {
      img.addRepresentation({
        scaleFactor: s.scaleFactor,
        width: s.size,
        height: s.size,
        buffer: fs.readFileSync(p),
      });
    } catch {}
  }
  return img;
}

function updateTray() {
  if (!tray) return;
  // 托盘三态（每种视觉独立，不再混淆）：
  //   1) proxyActive = 内核在线 && 系统代理开 → 纯彩（蓝底白立方，代理生效）
  //   2) coreOnline  = 内核在线 && 系统代理关 → 灰底 + 小蓝点（内核跑、代理未开）
  //   3) 否则        = 内核未连接             → 纯灰
  const proxyActive = !!(coreOnline && sysProxyOn);
  let img;
  if (coreOnline && !sysProxyOn) {
    const base = loadTrayImage(false);
    if (base.isEmpty()) {
      img = base;
    } else {
      try {
        const mark = nativeImage.createFromPath(path.join(iconsDir(), "tray-on-16.png"));
        if (!mark.isEmpty()) {
          const size = base.getSize();
          const dotW = Math.max(5, Math.round(size.width * 0.32));
          const dotH = Math.max(5, Math.round(size.height * 0.32));
          const dot = mark.resize({ width: dotW, height: dotH, quality: "best" });
          img = base.composite([{ input: dot, gravity: "southeast" }]);
          dot.destroy();
          try { mark.destroy(); } catch {}
        } else {
          img = base;
        }
      } catch {
        img = base;
      }
    }
  } else {
    img = loadTrayImage(proxyActive);
  }
  if (!img.isEmpty()) tray.setImage(img);
  const coreLabel = activeCore === "singbox" ? "sing-box" : "mihomo";
  let tip;
  if (proxyActive) {
    tip = `Veyra · 代理生效中（绿点）\n${coreLabel} · 127.0.0.1:${MIXED_PORT} · 系统代理：开`;
  } else if (coreOnline) {
    tip = `Veyra · 内核运行中，系统代理关（灰点）\n${coreLabel} · 127.0.0.1:${MIXED_PORT} · 在窗口或托盘菜单打开系统代理`;
  } else {
    tip = `Veyra · 未连接（灰点）\n当前内核：${coreLabel}`;
  }
  tray.setToolTip(tip);
  const statusLabel = proxyActive
    ? "状态：代理生效中"
    : coreOnline
      ? "状态：内核运行·代理关"
      : "状态：未连接";
  const curMode = (appSettings && appSettings.coreMode) || "rule";
  const modeItems = ["rule", "global", "direct"].map((m) => ({
    label: m === "rule" ? "规则模式" : m === "global" ? "全局模式" : "直连模式",
    type: "radio",
    checked: curMode === m,
    click: async () => {
      try {
        await setCoreMode(m, { notify: true });
      } catch {}
    },
  }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: "separator" },
      {
        label: "显示窗口",
        click: () => mainWindow?.show(),
      },
      {
        label: "轻量模式",
        type: "checkbox",
        checked: !!(appSettings && appSettings.lightweightMode),
        click: (item) => setLightweight(item.checked),
      },
      {
        label: sysProxyOn ? "关闭系统代理" : "开启系统代理",
        click: async () => {
          try {
            if (!coreOnline) {
              trayBalloon("Veyra", "内核未运行，无法开启系统代理");
              return;
            }
            await setSystemProxy(!sysProxyOn);
          } catch (e) {
            console.error(e);
          }
        },
      },
      {
        label: "系统代理",
        type: "checkbox",
        checked: !!sysProxyOn && appSettings?.proxyMode !== "pac",
        enabled: !!coreOnline,
        click: async (item) => {
          if (item.checked) {
            saveSettings({ proxyMode: "system" });
            await setSystemProxy(true);
          } else await setSystemProxy(false);
          updateTray();
        },
      },
      {
        label: "PAC 模式",
        type: "checkbox",
        checked: !!sysProxyOn && appSettings?.proxyMode === "pac",
        enabled: !!coreOnline,
        click: async (item) => {
          if (item.checked) await applyProxyMode("pac");
          else await applyProxyMode("off");
          updateTray();
        },
      },
      {
        label: "TUN 模式",
        type: "checkbox",
        checked: !!(appSettings && appSettings.tunEnable),
        click: async (item) => {
          saveSettings({ tunEnable: item.checked });
          try {
            await runEnhanceAndReload();
          } catch (e) {
            console.error(e);
          }
          updateTray();
        },
      },
      { type: "separator" },
      { label: "代理模式", submenu: modeItems },
      {
        label: "快速选节点",
        submenu: buildTrayProxySubmenu(),
      },
      { type: "separator" },
      {
        label: "退出",
        click: async () => {
          await setSystemProxy(false);
          await stopCore();
          app.quit();
        },
      },
    ])
  );
}

function buildTrayProxySubmenu() {
  // 异步填充较难；点击时动态拉取
  return [
    {
      label: "刷新并打开选择…",
      click: async () => {
        try {
          const ov = await api("/proxies");
          const proxies = (ov.data && ov.data.proxies) || {};
          const groups = Object.entries(proxies).filter(
            ([, v]) => v && ["Selector", "URLTest", "Fallback", "LoadBalance"].includes(v.type)
          );
          if (!groups.length) {
            trayBalloon("Veyra", "暂无策略组");
            return;
          }
          const submenu = [];
          for (const [gname, g] of groups.slice(0, 8)) {
            const all = Array.isArray(g.all) ? g.all : [];
            submenu.push({
              label: gname,
              submenu: all.slice(0, 40).map((n) => ({
                label: `${n === g.now ? "✓ " : ""}${n}`,
                click: async () => {
                  try {
                    await api(`/proxies/${encodeURIComponent(gname)}`, "PUT", { name: n });
                    trayBalloon("已切换", `${gname} → ${n}`);
                  } catch {}
                },
              })),
            });
          }
          // 重建一次菜单带真实节点（临时）
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: "选择节点（临时菜单）", enabled: false },
              ...submenu,
              { type: "separator" },
              { label: "返回主菜单", click: () => updateTray() },
            ])
          );
        } catch (e) {
          trayBalloon("Veyra", String(e.message || e));
        }
      },
    },
  ];
}

// 状态广播：界面与托盘都只认 coreOnline 这一个真源。
// seq 在「结果产出时刻」自增，渲染层丢弃旧序号，避免并发探测乱序回包把新状态覆盖成旧状态。
let statusSeq = 0;
function sendStatus(extra = {}) {
  const msg = { running: coreOnline, seq: ++statusSeq, ...extra };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("core:status", msg);
    } catch {}
  }
  return msg;
}

function setCoreOnline(online, extra = {}) {
  coreOnline = !!online;
  updateTray();
  sendStatus(extra);
}

function createTray() {
  const img = loadTrayImage(false);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on("double-click", () => mainWindow?.show());
  updateTray();
}

/** 托盘气泡提示（Windows 通知），失败静默——仅用于状态变化提示 */
function trayBalloon(title, content) {
  try {
    if (!tray || typeof tray.displayBalloon !== "function") return;
    const icon = path.join(resourcesRoot(), "icons", "icon-32.png");
    tray.displayBalloon(
      fs.existsSync(icon) ? { title, content, icon: nativeImage.createFromPath(icon) } : { title, content }
    );
  } catch {}
}

function registerIpc() {
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => {
    if (appSettings?.closeToTray !== false) {
      mainWindow?.hide();
      trayBalloon(
        "Veyra 已最小化到托盘",
        coreOnline
          ? `代理仍在后台运行（127.0.0.1:${MIXED_PORT}）。点击托盘图标可重新打开窗口。`
          : "代理服务未运行。点击托盘图标可重新打开窗口。"
      );
    } else {
      app.quit();
    }
  });

  ipcMain.handle("core:start", async () => startCore());
  ipcMain.handle("core:stop", async () => {
    await stopCore({ clearProxy: true });
    return { running: false, sysProxy: false };
  });
  ipcMain.handle("core:restart", async () => {
    const wasProxy = sysProxyOn;
    await stopCore({ clearProxy: true });
    const r = await startCore();
    if (wasProxy) await setSystemProxy(true);
    return r;
  });
  ipcMain.handle("core:status", async () => {
    try {
      const ver = await api("/version");
      const running = ver.status === 200;
      apiFailStreak = 0;
      if (running !== coreOnline) setCoreOnline(running, { version: ver.data });
      else sendStatus({ version: ver.data });
      return { running, version: ver.data, pid: coreProc?.pid || null, seq: statusSeq };
    } catch {
      apiFailStreak += 1;
      // controller 连续 3 次(约 4.5s)不可达即判离线，不再因 coreProc 存在而硬保绿：
      // 进程僵死/controller 挂掉时，硬绿就是托盘与体感不一致的来源。
      // 启动瞬间(waitController 最长 10s)渲染层会看到短暂未连接，startCore 成功后会立即推绿纠正。
      if (coreOnline && apiFailStreak >= 3) setCoreOnline(false);
      else sendStatus();
      return { running: coreOnline, pid: coreProc?.pid || null, seq: statusSeq };
    }
  });
  ipcMain.handle("core:info", async () => {
    let apiVersion = null;
    try {
      const ver = await api("/version");
      if (ver.status === 200) apiVersion = ver.data;
    } catch {}
    return { ...coreInfo(), apiVersion };
  });
  ipcMain.handle("core:checkUpdate", async () => checkCoreUpdate());
  ipcMain.handle("core:update", async () => updateCoreBinary());
  // 重新匹配当前内核的最佳构建（mihomo：标准版↔兼容版按 CPU 实测；sing-box：重拉最新）
  ipcMain.handle("core:matchBuild", async () => updateCoreBinary());
  ipcMain.handle("core:switch", async (_e, next) => switchCore(next));
  ipcMain.handle("core:list", async () => coreList());

  ipcMain.handle("proxy:overview", async () => {
    const [proxies, configs, connections] = await Promise.all([
      api("/proxies"),
      api("/configs"),
      api("/connections"),
    ]);
    // 全量连接可能上百条、每条带大 metadata，全量过 IPC 每次都拖慢主进程；
    // 只回传最近 80 条 + 真实总数，首页/连接页都够用
    const raw = connections.data || {};
    const list = Array.isArray(raw.connections) ? raw.connections : [];
    const trimmed = [...list]
      .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
      .slice(0, 80);
    return {
      proxies: proxies.data,
      configs: configs.data,
      connections: {
        uploadTotal: raw.uploadTotal || 0,
        downloadTotal: raw.downloadTotal || 0,
        connections: trimmed,
      },
      connectionsCount: list.length,
      mixedPort: MIXED_PORT,
      controller: CONTROLLER,
      preferredPort: Number(appSettings?.mixedPort) || DEFAULT_MIXED,
      coreMemoryMB: coreMemoryMB(),
    };
  });

  ipcMain.handle("app:ports", async () => ({
    mixedPort: MIXED_PORT,
    controller: CONTROLLER,
    preferredPort: Number(appSettings?.mixedPort) || DEFAULT_MIXED,
  }));

  ipcMain.handle("settings:get", async () => loadSettings());
  ipcMain.handle("settings:set", async (_e, patch) => {
    const p = { ...(patch || {}) };
    if (p.webdavPass && !String(p.webdavPass).startsWith("enc:")) {
      p.webdavPass = vergeExt.obscureSecret(p.webdavPass);
    }
    const next = saveSettings(p);
    if (p && ("startWithWindows" in p || "startMinimized" in p)) {
      app.setLoginItemSettings({
        openAtLogin: !!next.startWithWindows,
        openAsHidden: !!next.startMinimized,
      });
    }
    patch = p;
    if (patch && ("proxyGuard" in patch || "proxyMode" in patch)) applyProxyGuardLoop();
    if (
      patch &&
      ("hotkeyToggleProxy" in patch ||
        "hotkeyToggleWindow" in patch ||
        "hotkeyModeRule" in patch ||
        "hotkeyModeGlobal" in patch ||
        "hotkeyModeDirect" in patch)
    ) {
      registerHotkeys();
    }
    if (patch && "lightweightMode" in patch) setLightweight(!!next.lightweightMode);
    const needEnhance =
      patch &&
      ("tunEnable" in patch ||
        "tunStack" in patch ||
        "tunAutoRoute" in patch ||
        "tunStrictRoute" in patch ||
        "tunSniff" in patch ||
        "dnsOverride" in patch ||
        "dnsMode" in patch ||
        "dnsNameserver" in patch ||
        "dnsHosts" in patch ||
        "bindAddress" in patch ||
        "allowLan" in patch ||
        "unifiedDelay" in patch ||
        "tcpConcurrent" in patch);
    if (needEnhance) {
      try {
        await runEnhanceAndReload();
      } catch (e) {
        console.error(e);
      }
    }
    updateTray();
    return next;
  });
  ipcMain.handle("settings:applyNetwork", async (_e, patch) => {
    const next = saveSettings(patch || {});
    ensureDirs();
    await pickPorts();
    // 强制使用用户设置的端口（若空闲）
    if (patch?.mixedPort) {
      const want = Number(patch.mixedPort);
      if (await portFree(want)) MIXED_PORT = want;
    }
    if (patch?.controllerPort) {
      const want = Number(patch.controllerPort);
      if (await portFree(want)) CONTROLLER = `127.0.0.1:${want}`;
    }
    if (patch?.secret) SECRET = String(patch.secret);
    patchRuntimePorts();
    // 含「收养的遗留内核」场景（coreProc 为空但 controller 可达）：
    // 若只按 coreProc 判断，改端口后内核仍监听旧端口，而系统代理已指向新端口 → 全部断流。
    const was = !!coreProc || !!coreOnline;
    if (was) {
      // 改端口/secret 重启后保留系统代理，避免用户代理被静默关闭
      const wasProxy = sysProxyOn;
      await stopCore({ clearProxy: false });
      await startCore();
      if (wasProxy) await setSystemProxy(true);
    }
    return { settings: next, mixedPort: MIXED_PORT, controller: CONTROLLER };
  });
  ipcMain.handle("settings:openPath", async (_e, which) => {
    const map = {
      config: configDir(),
      bin: path.dirname(binPath()),
      userdata: userData(),
      settings: settingsPath(),
    };
    const p = map[which] || configDir();
    if (which === "settings" || which === "bin") {
      if (fs.existsSync(p)) await shell.showItemInFolder(p);
      else await shell.openPath(path.dirname(p));
    } else {
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      await shell.openPath(p);
    }
    return { ok: true, path: p };
  });
  ipcMain.handle("settings:copy", async (_e, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });
  ipcMain.handle("app:info", async () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isDev,
    userData: userData(),
  }));
  ipcMain.handle("connections:closeAll", async () => {
    try {
      return await api("/connections", "DELETE");
    } catch (e) {
      throw new Error(String(e.message || e));
    }
  });
  ipcMain.handle("connections:list", async () => {
    const c = await api("/connections");
    return c.data || { connections: [], downloadTotal: 0, uploadTotal: 0 };
  });
  ipcMain.handle("connections:close", async (_e, id) => {
    return api(`/connections/${encodeURIComponent(id)}`, "DELETE");
  });

  ipcMain.handle("rules:list", async () => {
    try {
      const r = await api("/rules");
      return r.data || { rules: [] };
    } catch {
      // fallback: runtime yaml
      try {
        const text = fs.readFileSync(runtimeConfig(), "utf8");
        const cfg = getYaml().load(text) || {};
        return { rules: (cfg.rules || []).map((str) => ({ payload: String(str), type: "Rule", size: 0 })) };
      } catch {
        return { rules: [] };
      }
    }
  });
  ipcMain.handle("rules:saveVisual", async (_e, rules) => {
    ensureDirs();
    const arr = Array.isArray(rules) ? rules.map(String) : [];
    const name = "visual-rules";
    const existing = profilesLib.listRich(profilesDir()).find((p) => p.type === "rules" && p.name === name);
    const body = `rules:\n${arr.map((r) => `  - ${JSON.stringify(r)}`).join("\n")}\n`;
    if (existing) {
      profilesLib.writeContent(profilesDir(), existing.uid, body);
      profilesLib.setEnabled(profilesDir(), existing.uid, true);
    } else {
      const item = profilesLib.createEnhance(profilesDir(), "rules", name, true);
      profilesLib.writeContent(profilesDir(), item.uid, body);
    }
    const er = await runEnhanceAndReload();
    return { ok: true, warnings: er.warnings };
  });

  ipcMain.handle("providers:list", async () => {
    try {
      const [pp, rp] = await Promise.all([api("/providers/proxies"), api("/providers/rules")]);
      return {
        proxies: (pp.data && pp.data.providers) || {},
        rules: (rp.data && rp.data.providers) || {},
      };
    } catch (e) {
      return { proxies: {}, rules: {}, error: String(e.message || e) };
    }
  });
  ipcMain.handle("providers:update", async (_e, kind, name) => {
    const pathApi =
      kind === "rules"
        ? `/providers/rules/${encodeURIComponent(name)}`
        : `/providers/proxies/${encodeURIComponent(name)}`;
    return api(pathApi, "PUT");
  });

  ipcMain.handle("verge:proxyMode", async (_e, mode) => applyProxyMode(mode));
  ipcMain.handle("verge:dnsValidate", async (_e, ns) => vergeExt.validateDns(ns));
  ipcMain.handle("verge:serviceStatus", async () => winService.serviceStatus());
  ipcMain.handle("verge:serviceInstall", async () => {
    const cfgPath = activeCore === "singbox" ? singboxConfig() : runtimeConfig();
    const r = await winService.installService({
      binPath: coreBinPath(activeCore),
      workDir: path.dirname(cfgPath),
      configFile: path.basename(cfgPath),
    });
    saveSettings({ serviceMode: true });
    return r;
  });
  ipcMain.handle("verge:serviceUninstall", async () => {
    const r = await winService.uninstallService();
    saveSettings({ serviceMode: false });
    return r;
  });
  ipcMain.handle("verge:uwpLoopback", async () => vergeExt.enableUwpLoopback());
  ipcMain.handle("verge:backupExport", async () => {
    const r = vergeExt.exportBackupZip({
      userData: userData(),
      settingsPath: settingsPath(),
      configDir: configDir(),
    });
    return r;
  });
  ipcMain.handle("verge:backupImport", async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "导入 Veyra 备份",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
      properties: ["openFile"],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    const r = vergeExt.importBackupZip(picked.filePaths[0], {
      userData: userData(),
      settingsPath: settingsPath(),
      configDir: configDir(),
    });
    loadSettings();
    try {
      await runEnhanceAndReload();
    } catch {}
    return r;
  });
  ipcMain.handle("verge:backupReveal", async () => {
    const dir = path.join(userData(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });
  ipcMain.handle("verge:webdavUpload", async () => {
    const s = loadSettings();
    const exp = vergeExt.exportBackupZip({
      userData: userData(),
      settingsPath: settingsPath(),
      configDir: configDir(),
    });
    const body = fs.readFileSync(exp.path);
    return vergeExt.webdavPut({
      url: s.webdavUrl,
      user: s.webdavUser,
      pass: vergeExt.revealSecret(s.webdavPass || ""),
      body,
      remoteName: s.webdavRemote || "veyra-backup.zip",
      retries: 3,
    });
  });
  ipcMain.handle("verge:webdavDownload", async () => {
    const s = loadSettings();
    const got = await vergeExt.webdavGet({
      url: s.webdavUrl,
      user: s.webdavUser,
      pass: vergeExt.revealSecret(s.webdavPass || ""),
      remoteName: s.webdavRemote || "veyra-backup.zip",
      retries: 3,
    });
    const tmp = path.join(userData(), "webdav-restore.zip");
    fs.writeFileSync(tmp, got.body);
    const r = vergeExt.importBackupZip(tmp, {
      userData: userData(),
      settingsPath: settingsPath(),
      configDir: configDir(),
    });
    loadSettings();
    try {
      await runEnhanceAndReload();
    } catch {}
    return r;
  });
  ipcMain.handle("verge:exitIp", async () => vergeExt.fetchExitIp(MIXED_PORT));
  ipcMain.handle("system:detectProxyConflict", async () => detectOtherProxy());
  ipcMain.handle("verge:streaming", async () => streamingUnlock.runUnlockChecks(MIXED_PORT));
  ipcMain.handle("verge:streamingOne", async (_e, id) => streamingUnlock.runOne(MIXED_PORT, id));
  ipcMain.handle("verge:unlockCatalog", async () => streamingUnlock.catalog());
  ipcMain.handle("verge:proxyEnv", async () => ({ text: vergeExt.proxyEnvText(MIXED_PORT) }));
  ipcMain.handle("verge:importUri", async (_e, uri) => {
    const built = uriImport.proxyToYamlDoc(uriImport.parseNodeUri(uri));
    ensureDirs();
    return applyProfileContent(built.name + ".yaml", built.content, "local", null);
  });
  ipcMain.handle("verge:vcRuntime", async () => {
    if (process.platform !== "win32") return { ok: true, installed: true };
    try {
      const sys = process.env.SystemRoot || "C\\\\Windows";
      const dll = path.join(sys, "System32", "vcruntime140.dll");
      const installed = fs.existsSync(dll);
      return {
        ok: installed,
        installed,
        downloadUrl: "https://aka.ms/vs/17/release/vc_redist.x64.exe",
      };
    } catch {
      return { ok: false, installed: false };
    }
  });
  ipcMain.handle("verge:downloadVc", async () => {
    await shell.openExternal("https://aka.ms/vs/17/release/vc_redist.x64.exe");
    return { ok: true };
  });
  ipcMain.handle("verge:openWebUI", async (_e, which) => {
    const host = CONTROLLER;
    const map = {
      metacubexd: `https://metacubex.github.io/metacubexd/#/setup?hostname=${host.split(":")[0]}&port=${host.split(":")[1]}&secret=${encodeURIComponent(SECRET)}`,
      yacd: `https://yacd.haishan.me/?hostname=${host.split(":")[0]}&port=${host.split(":")[1]}&secret=${encodeURIComponent(SECRET)}`,
      zashboard: `https://board.zash.run.place/#/setup?hostname=${host.split(":")[0]}&port=${host.split(":")[1]}&secret=${encodeURIComponent(SECRET)}`,
    };
    const url = map[which] || map.metacubexd;
    await shell.openExternal(url);
    return { ok: true, url };
  });
  ipcMain.handle("profile:setBinds", async (_e, uid, binds) => {
    ensureDirs();
    return profilesLib.setProfileBinds(profilesDir(), uid, binds || {});
  });
  ipcMain.handle("runtime:read", async () => {
    if (fs.existsSync(runtimeConfig())) return fs.readFileSync(runtimeConfig(), "utf8");
    return "";
  });
  ipcMain.handle("runtime:write", async (_e, content) => {
    ensureDirs();
    fs.writeFileSync(runtimeConfig(), String(content || ""), "utf8");
    await reloadRuntimeConfig();
    return { ok: true };
  });
  ipcMain.handle("logs:clearFile", async () => {
    const logDir = path.join(userData(), "logs");
    if (!fs.existsSync(logDir)) return { ok: true, removed: 0 };
    const days = Number(appSettings?.logAutoCleanDays) || 0;
    let removed = 0;
    const now = Date.now();
    for (const f of fs.readdirSync(logDir)) {
      const full = path.join(logDir, f);
      try {
        const st = fs.statSync(full);
        if (days > 0 && now - st.mtimeMs > days * 86400000) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {}
    }
    return { ok: true, removed };
  });
  ipcMain.handle("proxy:patchConfig", async (_e, body) => {
    return api("/configs", "PATCH", body || {});
  });

  ipcMain.handle("proxy:select", async (_e, group, name) => {
    return api(`/proxies/${encodeURIComponent(group)}`, "PUT", { name });
  });

  ipcMain.handle("proxy:delay", async (_e, name) => {
    const url = encodeURIComponent("https://www.gstatic.com/generate_204");
    try {
      return await api(`/proxies/${encodeURIComponent(name)}/delay?timeout=5000&url=${url}`);
    } catch (e) {
      // 节点超时/不可达是测速的常规结果：返回结构化 delay=0 而不是抛异常，
      // 否则 Electron 会为每个失败节点在主进程打印一整段堆栈（全量测速可达上百条）。
      return { status: 0, data: { delay: 0 }, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("proxy:mode", async (_e, mode) => {
    // 走统一入口：缓存 mode 供托盘菜单显示勾选，并立即刷新托盘
    const m = mode === "global" || mode === "direct" ? mode : "rule";
    const r = await setCoreMode(m, { notify: true });
    return r;
  });

  ipcMain.handle("system:proxy", async (_e, enable) => setSystemProxy(!!enable));

  ipcMain.handle("profile:list", async () => {
    ensureDirs();
    profilesLib.migrateLegacyFiles(profilesDir());
    const rich = profilesLib.listRich(profilesDir());
    if (rich.length) {
      return rich.map((p) => ({
        name: p.name,
        path: path.join(profilesDir(), p.file),
        size: p.size,
        uid: p.uid,
        type: p.type,
        enabled: p.enabled,
        global: p.global,
        url: p.url,
        updatedAt: p.updatedAt,
      }));
    }
    const files = fs.readdirSync(profilesDir()).filter((f) => /\.(ya?ml|js)$/i.test(f) && f !== "index.json");
    return files.map((f) => ({
      name: f,
      path: path.join(profilesDir(), f),
      size: fs.statSync(path.join(profilesDir(), f)).size,
    }));
  });

  ipcMain.handle("profile:listRich", async () => {
    ensureDirs();
    profilesLib.migrateLegacyFiles(profilesDir());
    return profilesLib.listRich(profilesDir());
  });

  ipcMain.handle("profile:import", async (_e, { name, content }) => {
    return applyProfileContent(name, content, "local");
  });

  ipcMain.handle("profile:importUrl", async (_e, { url, name }) => {
    if (!url || !/^https?:\/\//i.test(url.trim())) {
      throw new Error("请输入有效的 http(s) 订阅链接");
    }
    const retries = Math.max(1, Number(appSettings?.subRetry) || 3);
    const timeoutSec = Math.max(5, Number(appSettings?.subTimeoutSec) || 30);
    let raw = "";
    let subHeaders = {};
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
      try {
        const fetched = await fetchSubscription(url.trim(), { timeoutMs: timeoutSec * 1000 });
        raw = fetched.body;
        subHeaders = fetched.headers || {};
        if (raw && raw.length > 8) break;
      } catch (e) {
        lastErr = e;
        // 429 限流时拉长退避，避免连续请求加重限流
        const backoff = /429/.test(String(e?.message || e)) ? 5000 * (i + 1) : 600 * (i + 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    if (!raw || raw.length < 8) {
      throw new Error(`订阅拉取失败（重试 ${retries} 次）：${lastErr?.message || "内容为空"}`);
    }
    const content = normalizeSubscriptionBody(raw);
    if (!content || content.length < 8) {
      throw new Error("订阅内容为空或无法解析");
    }
    const result = await applyProfileContent(name || guessNameFromUrl(url), content, "remote", url.trim());
    const metaPath = path.join(configDir(), "subscriptions.json");
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {}
    if (!Array.isArray(list)) list = [];
    const intervalMin = Number(appSettings?.subAutoUpdateMin) || 0;
    const userinfo = parseSubscriptionUserinfo(subHeaders);
    // 机场通过 profile-update-interval 头（小时）建议更新周期，参考 clash-verge-rev 优先采用
    let headerIntervalHours = 0;
    for (const k of Object.keys(subHeaders || {})) {
      if (k.toLowerCase() === "profile-update-interval") {
        headerIntervalHours = Number(subHeaders[k]) || 0;
        break;
      }
    }
    const intervalMs = headerIntervalHours > 0
      ? headerIntervalHours * 3600_000
      : intervalMin > 0
        ? intervalMin * 60_000
        : 0;
    const prevEntry = list.find((x) => x.url === url.trim());
    const entry = {
      url: url.trim(),
      name: path.basename(result.path),
      updatedAt: Date.now(),
      nextUpdateAt: intervalMs > 0 ? Date.now() + intervalMs : 0,
      lastError: "",
      // 本次拉取没带流量头（机场限流/部分 UA 不下发）时保留旧值，避免把已有流量数据冲掉
      ...(userinfo
        ? { userinfo }
        : prevEntry?.userinfo
          ? { userinfo: prevEntry.userinfo }
          : {}),
    };
    list = [entry, ...list.filter((x) => x.url !== entry.url)].slice(0, 20);
    fs.writeFileSync(metaPath, JSON.stringify(list, null, 2), "utf8");
    return { ...result, bytes: content.length, preview: content.slice(0, 200), nextUpdateAt: entry.nextUpdateAt };
  });

  ipcMain.handle("profile:setNextUpdate", async (_e, url, nextUpdateAt) => {
    const metaPath = path.join(configDir(), "subscriptions.json");
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {}
    list = (Array.isArray(list) ? list : []).map((x) =>
      x.url === url ? { ...x, nextUpdateAt: Number(nextUpdateAt) || 0 } : x
    );
    fs.writeFileSync(metaPath, JSON.stringify(list, null, 2), "utf8");
    return { ok: true };
  });

  ipcMain.handle("profile:subscriptions", async () => {
    const metaPath = path.join(configDir(), "subscriptions.json");
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      return [];
    }
  });

  ipcMain.handle("profile:activate", async (_e, uid) => {
    ensureDirs();
    const idx = profilesLib.setActive(profilesDir(), uid);
    const er = await runEnhanceAndReload();
    return { ok: true, index: idx, warnings: er.warnings, scriptLogs: er.scriptLogs };
  });

  ipcMain.handle("profile:setEnabled", async (_e, uid, enabled) => {
    ensureDirs();
    return profilesLib.setEnabled(profilesDir(), uid, enabled);
  });

  ipcMain.handle("profile:createEnhance", async (_e, kind, name, global) => {
    ensureDirs();
    return profilesLib.createEnhance(profilesDir(), kind, name, !!global);
  });

  ipcMain.handle("profile:delete", async (_e, uid) => {
    ensureDirs();
    profilesLib.deleteProfile(profilesDir(), uid);
    return { ok: true };
  });

  ipcMain.handle("profile:read", async (_e, uid) => {
    ensureDirs();
    return profilesLib.readContent(profilesDir(), uid);
  });

  ipcMain.handle("profile:write", async (_e, uid, content) => {
    ensureDirs();
    profilesLib.writeContent(profilesDir(), uid, content);
    return { ok: true };
  });

  ipcMain.handle("profile:enhancePreview", async () => {
    ensureDirs();
    profilesLib.migrateLegacyFiles(profilesDir());
    const r = enhance(profilesDir(), runtimeConfig(), enhanceOpts());
    return { yaml: r.text, warnings: r.warnings, scriptLogs: r.scriptLogs };
  });

  ipcMain.handle("profile:enhanceApply", async () => {
    const er = await runEnhanceAndReload();
    return {
      ok: true,
      bytes: er.text.length,
      warnings: er.warnings,
      scriptLogs: er.scriptLogs,
    };
  });

  ipcMain.handle("system:proxyStatus", async () => {
    const st = await getSystemProxyStatus();
    // 对外「enabled」表示Veyra接管的系统代理，避免把其它代理软件当成我们的
    sysProxyOn = !!st.ours;
    return { enabled: !!st.ours, server: st.server || "", rawEnabled: !!st.enabled };
  });

  ipcMain.handle("profile:readActive", async () => {
    ensureDirs();
    if (fs.existsSync(runtimeConfig())) return fs.readFileSync(runtimeConfig(), "utf8");
    return profilesLib.activeMainText(profilesDir(), runtimeConfig());
  });

  ipcMain.handle("traffic:now", async () => {
    try {
      // /traffic 是 SSE 长连接（response 永不 end），普通请求会一直挂起到 4s 超时或被吞掉；
      // 这里直接读 /connections 的 upload/download 总量，语义等价且必然返回。
      const c = await api("/connections");
      return c.data;
    } catch {
      return null;
    }
  });

  ipcMain.handle("open:external", async (_e, url) => {
    await shell.openExternal(url);
  });
}

/** 首次启动时把旧品牌（Aurora / MoonCat）的数据目录迁移过来，避免订阅与配置丢失 */
function migrateLegacyData() {
  try {
    const dest = userData();
    if (fs.existsSync(path.join(dest, "settings.json"))) return;
    for (const name of ["Crescent", "MoonCat", "mooncat", "aurora-proxy"]) {
      const legacy = path.join(app.getPath("appData"), name);
      if (legacy === dest) continue;
      if (!fs.existsSync(path.join(legacy, "settings.json"))) continue;
      fs.mkdirSync(dest, { recursive: true });
      for (const item of ["settings.json", "config"]) {
        const src = path.join(legacy, item);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(dest, item);
        if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
        else fs.copyFileSync(src, dst);
      }
      console.log("[veyra] migrated legacy data from", legacy);
      return;
    }
  } catch {}
}

// 单实例锁：第二个实例直接退出，并把已有窗口带到前台。
// 没有锁的话，重复启动会出现两个实例各占一个 controller 端口（pickPorts 会自动 +10003 换端口），
// 结果是「托盘显示 A 实例的绿点、窗口却是 B 实例的未连接」——两套状态永远对不上。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

app.whenReady().then(async () => {
  // 抢锁失败的实例绝不做任何启动工作：不起窗口、不起托盘、不动内核。
  // 否则第二个实例临退出前还会建窗口/调 startCore，出现「托盘是 A 实例绿点、窗口是 B 实例未连接」。
  if (!gotTheLock) return;
  migrateLegacyData();
  loadSettings();
  ensureDirs();
  try {
    profilesLib.migrateLegacyFiles(profilesDir());
  } catch {}
  registerIpc();
  app.setLoginItemSettings({
    openAtLogin: !!appSettings.startWithWindows,
    openAsHidden: !!appSettings.startMinimized,
  });
  registerHotkeys();
  applyProxyGuardLoop();
  // 先同步注册表里是否还挂着上次残留的Veyra系统代理
  await syncSystemProxyState();
  createWindow();
  createTray();
  if (appSettings.lightweightMode) setLightweight(true);
  // 窗口隐藏时渲染层定时器会被节流，主进程每 3s 主动校准一次注册表，
  // 保证托盘图标/菜单与真实系统代理一致，再推给窗口。
  const sysProxyTimer = setInterval(() => {
    if (isQuitting) return;
    syncSystemProxyState().catch(() => {});
  }, 3000);
  if (sysProxyTimer.unref) sysProxyTimer.unref();
  // （已移除每秒全量 /connections 的 trafficTimer：渲染层并不消费该事件，
  //   但主进程每秒解析+IPC 序列化上百条连接会持续阻塞主进程，是全局卡顿的元凶）
  // 「启动最小化」只应作用于开机自启（已由上面的 openAsHidden 声明给系统），
  // 手动双击/命令行启动时必须正常显示窗口，否则用户会看到「启动后黑屏/无窗口」。
  const openedAtLogin = (() => {
    try {
      return !!app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  })();
  if (appSettings.lightweightMode || (appSettings.startMinimized && openedAtLogin)) mainWindow?.hide();
  // 内核随软件常驻：打开即运行；会话内显式停止后，更新订阅也不会再拉起（见 reloadRuntimeConfig）
  try {
    await startCore();
  } catch (e) {
    console.error("core start failed", e);
    if (mainWindow) mainWindow.webContents.send("core:error", String(e.message || e));
    toastNotify("内核启动失败", String(e.message || "请检查设置中的端口和内核路径"));
  }
  // 服务没起来却还指着我们的端口 → 关掉，避免整机断网
  if (!coreOnline) {
    await clearOurSystemProxy();
    trayBalloon("Veyra 已启动（托盘）", "代理服务未能启动，请打开窗口查看日志。托盘图标为灰色状态。");
  } else {
    await syncSystemProxyState();
    trayBalloon(
      "Veyra 已启动（托盘）",
      `代理服务运行中 · 127.0.0.1:${MIXED_PORT}。托盘绿点 = 系统代理已生效。`
    );
  }

  // —— 临时探针（VEYRA_SMOKE_PROXIES=1 时生效，验证完即删）：切到代理页滚动采集显示数据 ——
  if (process.env.VEYRA_SMOKE_PROXIES === "1") {
    setTimeout(async () => {
      const out = { ts: new Date().toISOString(), shots: [] };
      const shot = async (name) => {
        try {
          const img = await mainWindow.webContents.capturePage();
          const p = path.join(app.getPath("temp"), `veyra-${name}.png`);
          fs.writeFileSync(p, img.toPNG());
          out.shots.push(p);
        } catch (e) {
          out.shotErr = String((e && e.message) || e);
        }
      };
      try {
        await mainWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.nav-item')[1] && document.querySelectorAll('.nav-item')[1].click(); true`
        );
        await new Promise((r) => setTimeout(r, 6000));
        await shot("px-v3-top");
        // 模拟用户滑动：滚到 40% 停一下
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.stage'); if (el) el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.4); return true; })()`
        );
        await new Promise((r) => setTimeout(r, 1300));
        await shot("px-v3-mid");
        // 继续滚到 70%
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.stage'); if (el) el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.7); return true; })()`
        );
        await new Promise((r) => setTimeout(r, 1300));
        await shot("px-v3-mid2");
        // 滚到底
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.stage'); if (el) el.scrollTop = el.scrollHeight; return true; })()`
        );
        await new Promise((r) => setTimeout(r, 1300));
        await shot("px-v3-bottom");
        out.check = JSON.parse(
          await mainWindow.webContents.executeJavaScript(`(() => {
            const hc = document.querySelector('.px-header-card');
            const cs = hc ? getComputedStyle(hc) : null;
            return JSON.stringify({
              bg: cs ? cs.backgroundColor : null,
              transform: cs ? cs.transform : null,
              willChange: cs ? cs.willChange : null,
              cards: document.querySelectorAll('.px-card').length
            });
          })()`)
        );
      } catch (e) {
        out.err = String((e && e.message) || e);
      }
      console.log("[PROXIES_RESULT]" + JSON.stringify(out));
      isQuitting = true;
      try {
        await stopCore({ clearProxy: false });
      } catch {}
      app.exit(0);
    }, 8000);
  }
});

app.on("window-all-closed", () => {
  // 托盘常驻应用：不调用 app.quit() 即可阻止默认退出（事件对象本身没有 preventDefault 语义）
});

app.on("before-quit", (e) => {
  // 抢锁失败的实例直接原样退出：清理逻辑会 taskkill mihomo，会误杀正常实例的内核
  if (!gotTheLock) return;
  if (isQuitting) return;
  e.preventDefault();
  isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch {}
  vergeExt.stopProxyGuard();
  vergeExt.stopPacServer();
  (async () => {
    try {
      await clearOurSystemProxy();
      await stopCore({ clearProxy: false });
    } catch (err) {
      console.error("quit cleanup failed", err);
    } finally {
      app.exit(0);
    }
  })();
});
