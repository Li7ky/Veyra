/**
 * Clash Verge 对齐扩展：TUN / PAC / 代理守护 / DNS / 备份 / UWP / 流媒体 / 环境变量
 * 由 main.cjs 注入依赖后调用。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile, spawn } = require("child_process");
const zlib = require("zlib");
const crypto = require("crypto");

function promisifyExec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: opts.headers || {},
        timeout: opts.timeout || 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** ---- PAC 本地服务 ---- */
let pacServer = null;
let pacPort = 0;

function pacScript(mixedPort) {
  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === "127.0.0.1" || host === "localhost") return "DIRECT";
  if (shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") || shExpMatch(host, "172.16.*")) return "DIRECT";
  return "PROXY 127.0.0.1:${mixedPort}; DIRECT";
}
`;
}

function startPacServer(mixedPort) {
  return new Promise((resolve, reject) => {
    if (pacServer) {
      try {
        pacServer.close();
      } catch {}
      pacServer = null;
    }
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ns-proxy-autoconfig" });
      res.end(pacScript(mixedPort));
    });
    srv.listen(0, "127.0.0.1", () => {
      pacServer = srv;
      pacPort = srv.address().port;
      resolve(pacPort);
    });
    srv.on("error", reject);
  });
}

function stopPacServer() {
  if (pacServer) {
    try {
      pacServer.close();
    } catch {}
    pacServer = null;
    pacPort = 0;
  }
}

async function setWinProxyMode({ mode, mixedPort, bypass, regAdd, refreshWinInet }) {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  if (mode === "off") {
    stopPacServer();
    await regAdd(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
    await regAdd(["add", key, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", "", "/f"]);
    await refreshWinInet();
    return { ok: true, mode: "off" };
  }
  if (mode === "pac") {
    const port = await startPacServer(mixedPort);
    const url = `http://127.0.0.1:${port}/proxy.pac`;
    await regAdd(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
    await regAdd(["add", key, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", url, "/f"]);
    await refreshWinInet();
    return { ok: true, mode: "pac", pacUrl: url };
  }
  // system = classic proxy
  stopPacServer();
  const server = `127.0.0.1:${mixedPort}`;
  await regAdd(["add", key, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", "", "/f"]);
  await regAdd(["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", server, "/f"]);
  await regAdd(["add", key, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", bypass, "/f"]);
  await regAdd(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]);
  await refreshWinInet();
  return { ok: true, mode: "system", server, bypass };
}

/** ---- 代理守护 ---- */
let guardTimer = null;

function startProxyGuard({ getDesired, apply, intervalMs = 5000 }) {
  stopProxyGuard();
  guardTimer = setInterval(async () => {
    try {
      const desired = getDesired();
      if (!desired || !desired.enabled) return;
      await apply(desired);
    } catch {}
  }, intervalMs);
}

function stopProxyGuard() {
  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
  }
}

/** ---- DNS 校验 ---- */
async function validateDns(nameserver) {
  const ns = String(nameserver || "").trim();
  if (!ns) return { ok: false, error: "空 nameserver" };
  // 轻量：能解析出 host:port 即通过；真实 dig 依赖系统
  const m = ns.match(/^(?:tls:\/\/|https:\/\/|quic:\/\/|dhcp:\/\/)?([^:#/\s]+)/i);
  if (!m) return { ok: false, error: "格式无效" };
  return { ok: true, host: m[1] };
}

/** ---- TUN 配置片段 ---- */
function buildTunConfig(settings) {
  const enabled = !!settings.tunEnable;
  return {
    enable: enabled,
    stack: settings.tunStack || "gvisor",
    "auto-route": settings.tunAutoRoute !== false,
    "strict-route": !!settings.tunStrictRoute,
    "auto-detect-interface": settings.tunAutoDetect !== false,
    sniffer: !!settings.tunSniff,
    "dns-hijack": Array.isArray(settings.tunDnsHijack)
      ? settings.tunDnsHijack
      : ["any:53", "tcp://any:53"],
    mtu: Number(settings.tunMtu) || 9000,
    device: settings.tunDevice || "Veyra",
  };
}

function buildDnsConfig(settings) {
  return {
    enable: settings.dnsEnable !== false,
    listen: settings.dnsListen || "0.0.0.0:1053",
    ipv6: !!settings.dnsIpv6,
    "enhanced-mode": settings.dnsMode || "fake-ip",
    "fake-ip-range": settings.dnsFakeIpRange || "198.18.0.1/16",
    "fake-ip-filter": settings.dnsFakeIpFilter || ["*.lan", "localhost", "*.local"],
    nameserver: settings.dnsNameserver || ["https://doh.pub/dns-query", "tls://dns.alidns.com"],
    fallback: settings.dnsFallback || ["tls://1.1.1.1", "tls://8.8.8.8"],
    "default-nameserver": settings.dnsDefaultNs || ["223.5.5.5", "119.29.29.29"],
    hosts: settings.dnsHosts || {},
  };
}

/** ---- UWP 回环 ---- */
async function enableUwpLoopback() {
  if (process.platform !== "win32") throw new Error("仅 Windows");
  // 启用所有已安装 UWP 的回环（CheckNetIsolation LoopbackExempt -a -n=）
  const ps = `
Get-AppxPackage | ForEach-Object {
  CheckNetIsolation.exe LoopbackExempt -a -n="$($_.PackageFamilyName)" 2>$null | Out-Null
}
'ok'
`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  await promisifyExec("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], { timeout: 120000 });
  return { ok: true };
}

/** ---- ZIP 备份（store + deflate 简易实现） ---- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function zipStore(files) {
  // files: [{name, data: Buffer}]
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(Buffer.concat([local, data]));
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

function collectDirFiles(root, base = "") {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collectDirFiles(full, rel));
    else out.push({ name: rel.replace(/\\/g, "/"), data: fs.readFileSync(full) });
  }
  return out;
}

function exportBackupZip({ userData, settingsPath, configDir }) {
  const files = [];
  if (fs.existsSync(settingsPath)) {
    files.push({ name: "settings.json", data: fs.readFileSync(settingsPath) });
  }
  files.push(...collectDirFiles(configDir, "config"));
  const buf = zipStore(files);
  const outDir = path.join(userData, "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `veyra-backup-${stamp}.zip`);
  fs.writeFileSync(outPath, buf);
  return { ok: true, path: outPath, bytes: buf.length, count: files.length };
}

function unzipStore(buf, destDir) {
  // 仅支持 store/deflate 方法的简易解压（本备份格式）。
  // 安全防护：bit 3（data descriptor，local header 里 size=0）直接拒绝；
  // 条目名过滤 .. / 绝对路径 / 盘符，防止 zip-slip 写出到 destDir 之外。
  let offset = 0;
  const extracted = [];
  const resolvedDest = path.resolve(destDir);
  while (offset + 4 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString("utf8");
    if (flags & 0x08) {
      // data descriptor：真实大小在数据尾部，local header 里 compSize=0，
      // 解析会错位并静默产出空文件——只接受自家 zipStore 导出的不带 bit3 的 zip
      throw new Error(`压缩包条目使用了不支持的 data descriptor 格式：${name}`);
    }
    if (!name || name.includes("..") || /^[a-zA-Z]:/.test(name) || name.startsWith("/") || name.startsWith("\\")) {
      throw new Error(`压缩包含非法路径条目：${name}`);
    }
    const dataStart = offset + 30 + nameLen + extraLen;
    let data = buf.slice(dataStart, dataStart + compSize);
    if (method === 8) data = zlib.inflateRawSync(data);
    else if (method !== 0) throw new Error(`不支持的压缩方法 ${method}`);
    const target = path.resolve(path.join(destDir, name));
    if (!target.startsWith(resolvedDest + path.sep) && target !== resolvedDest) {
      throw new Error(`压缩包条目路径逃逸：${name}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    extracted.push(name);
    offset = dataStart + compSize;
  }
  return extracted;
}

function importBackupZip(zipPath, { userData, settingsPath, configDir }) {
  const buf = fs.readFileSync(zipPath);
  const tmp = path.join(userData, "backup-import-tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const names = unzipStore(buf, tmp);
  const sSrc = path.join(tmp, "settings.json");
  if (fs.existsSync(sSrc)) fs.copyFileSync(sSrc, settingsPath);
  const cSrc = path.join(tmp, "config");
  if (fs.existsSync(cSrc)) {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.mkdirSync(configDir, { recursive: true });
    copyRecursive(cSrc, configDir);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ok: true, files: names };
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** ---- WebDAV ---- */
async function webdavRequest(method, { url, user, pass, body, remoteName, retries = 3 }) {
  const base = url.replace(/\/$/, "");
  let target = `${base}/${remoteName || "veyra-backup.zip"}`;
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await httpJson(target, {
        method,
        headers: {
          Authorization: auth,
          "User-Agent": "Veyra-WebDAV/1.0",
          ...(body
            ? { "Content-Type": "application/zip", "Content-Length": body.length }
            : {}),
        },
        body,
        timeout: 90000,
      });
      // 跟随一次重定向（服务器可能返回相对路径，需基于当前 target 解析绝对地址）
      if ([301, 302, 307, 308].includes(r.status) && r.headers.location) {
        try {
          target = new URL(String(r.headers.location), target).toString();
        } catch {
          target = String(r.headers.location);
        }
        continue;
      }
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, url: target, body: r.body };
      lastErr = new Error(`WebDAV ${method} 失败 HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw lastErr || new Error(`WebDAV ${method} 失败`);
}

async function webdavPut(opts) {
  return webdavRequest("PUT", opts);
}

async function webdavGet(opts) {
  return webdavRequest("GET", opts);
}

/** 简单混淆存储（非高强度加密，防明文落盘） */
function obscureSecret(text, key = "veyra-webdav") {
  const buf = Buffer.from(String(text || ""), "utf8");
  const k = Buffer.from(key);
  for (let i = 0; i < buf.length; i++) buf[i] ^= k[i % k.length];
  return "enc:" + buf.toString("base64");
}

function revealSecret(text, key = "veyra-webdav") {
  const s = String(text || "");
  if (!s.startsWith("enc:")) return s;
  const buf = Buffer.from(s.slice(4), "base64");
  const k = Buffer.from(key);
  for (let i = 0; i < buf.length; i++) buf[i] ^= k[i % k.length];
  return buf.toString("utf8");
}

/** ---- 流媒体解锁探测（经本地混合端口） ---- */
async function streamingUnlock(mixedPort) {
  const tests = [
    { id: "netflix", url: "https://www.netflix.com/title/81280792" },
    { id: "youtube", url: "https://www.youtube.com/premium" },
    { id: "disney", url: "https://www.disneyplus.com" },
    { id: "chatgpt", url: "https://chat.openai.com" },
  ];
  const results = [];
  for (const t of tests) {
    try {
      const r = await proxyFetch(t.url, mixedPort);
      results.push({
        id: t.id,
        // ok 只认 2xx/3xx：403（封锁）/451（法律原因不可用）说明该区域不可用，
        // 记成 ok 会让前端把「未解锁」渲染成绿色
        ok: r.status >= 200 && r.status < 400,
        status: r.status,
        note: r.status === 403 || r.status === 451 ? "可能未解锁" : r.status >= 200 && r.status < 400 ? "可达" : "异常",
      });
    } catch (e) {
      results.push({ id: t.id, ok: false, status: 0, note: String(e.message || e) });
    }
  }
  return results;
}

function proxyFetch(url, mixedPort) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: mixedPort,
        method: "GET",
        path: url,
        headers: {
          Host: u.host,
          "User-Agent": "Veyra-UnlockCheck/1.0",
        },
        timeout: 12000,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode || 0 });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/** ---- 出口 IP ---- */
async function fetchExitIp(mixedPort) {
  const urls = [
    "http://ip-api.com/json?fields=query,country,countryCode,city,regionName,isp,org,as,timezone,lat,lon",
    "http://ipinfo.io/json",
    "http://httpbin.org/ip",
  ];
  for (const url of urls) {
    try {
      const r = await proxyFetchBody(url, mixedPort);
      const text = r.toString("utf8");
      try {
        const j = JSON.parse(text);
        if (j.query) return {
          ip: j.query,
          country: j.country,
          countryCode: j.countryCode,
          city: j.city,
          region: j.regionName,
          isp: j.isp,
          org: j.org,
          as: j.as,
          timezone: j.timezone,
          lat: j.lat,
          lon: j.lon,
        };
        // ipinfo.io 格式
        if (j.ip) return {
          ip: j.ip,
          country: j.country,
          countryCode: j.country,
          city: j.city,
          region: j.region,
          isp: j.org,
          org: j.org,
          as: j.asn?.asn,
          timezone: j.timezone,
          lat: j.loc ? Number(j.loc.split(",")[0]) : null,
          lon: j.loc ? Number(j.loc.split(",")[1]) : null,
        };
        if (j.origin) return { ip: String(j.origin).split(",")[0].trim() };
      } catch {
        const m = text.match(/\d+\.\d+\.\d+\.\d+/);
        if (m) return { ip: m[0] };
      }
    } catch {}
  }
  return { ip: null };
}

function proxyFetchBody(url, mixedPort) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: mixedPort,
        method: "GET",
        path: url,
        headers: { Host: u.host, "User-Agent": "Veyra/1.0" },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function proxyEnvText(mixedPort) {
  const p = `http://127.0.0.1:${mixedPort}`;
  return [
    `set HTTP_PROXY=${p}`,
    `set HTTPS_PROXY=${p}`,
    `set ALL_PROXY=${p}`,
    `# bash/zsh:`,
    `export http_proxy=${p}`,
    `export https_proxy=${p}`,
    `export all_proxy=${p}`,
  ].join("\n");
}

/** ---- 单节点 URI 解析（基础） ---- */
function importNodeUri(uri) {
  const u = String(uri || "").trim();
  if (!u) throw new Error("空 URI");
  if (/^ss:\/\//i.test(u)) {
    // ss://method:pass@host:port#name 或 base64
    let name = "ss-node";
    const hash = u.indexOf("#");
    if (hash >= 0) name = decodeURIComponent(u.slice(hash + 1)) || name;
    return {
      name,
      type: "ss",
      raw: u,
      yamlHint: `# 请用订阅或完整 YAML；已记录 URI\n# ${u}\n`,
    };
  }
  if (/^(vmess|vless|trojan|hysteria2?|tuic):\/\//i.test(u)) {
    const proto = u.split("://")[0].toLowerCase();
    let name = `${proto}-node`;
    const hash = u.indexOf("#");
    if (hash >= 0) name = decodeURIComponent(u.slice(hash + 1)) || name;
    return { name, type: proto, raw: u, yamlHint: `# ${u}\n` };
  }
  throw new Error("不支持的节点 URI 协议");
}

module.exports = {
  setWinProxyMode,
  startPacServer,
  stopPacServer,
  startProxyGuard,
  stopProxyGuard,
  validateDns,
  buildTunConfig,
  buildDnsConfig,
  enableUwpLoopback,
  exportBackupZip,
  importBackupZip,
  webdavPut,
  webdavGet,
  obscureSecret,
  revealSecret,
  streamingUnlock,
  fetchExitIp,
  proxyEnvText,
  importNodeUri,
  pacPort: () => pacPort,
};
