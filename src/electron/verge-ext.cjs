/**
 * Clash Verge 对齐扩展：TUN / PAC / 代理守护 / DNS / 备份 / UWP / 流媒体 / 环境变量
 * 由 main.cjs 注入依赖后调用。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const tls = require("tls");
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
    // 用 delete 而不是写入空字符串：空的 AutoConfigURL 值仍然留在注册表里，
    // 任何「读注册表判断有没有开 PAC」的程序（包括我们自己的冲突检测）
    // 都容易把「值存在」误判成「PAC 已启用」。
    await regAdd(["delete", key, "/v", "AutoConfigURL", "/f"]);
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
  await regAdd(["delete", key, "/v", "AutoConfigURL", "/f"]);
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
    // 先拷到暂存目录、校验通过后再交换。
    // 旧实现是「先 rmSync(configDir) 再拷」，拷贝中途失败（文件被占用/磁盘满）
    // 就永久丢掉用户全部订阅与增强文件，且没有任何回滚手段。
    const stage = path.join(userData, "backup-import-stage");
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    try {
      copyRecursive(cSrc, stage);
      // 空目录视为不完整备份：宁可不动现有数据，也不要用空档案覆盖
      if (fs.readdirSync(stage).length === 0) {
        throw new Error("备份包中的 config 目录为空，已保留现有数据");
      }
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw new Error(`备份导入失败（已保留原有数据）：${(e && e.message) || e}`);
    }
    const backup = path.join(userData, "backup-import-prev");
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(configDir)) fs.renameSync(configDir, backup);
    try {
      fs.renameSync(stage, configDir);
    } catch (e) {
      // 交换失败：把原目录放回去，避免用户既没新数据也没旧数据
      fs.rmSync(configDir, { recursive: true, force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, configDir);
      throw new Error(`备份导入失败（已还原原有数据）：${(e && e.message) || e}`);
    }
    fs.rmSync(backup, { recursive: true, force: true });
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
const EXIT_IP_UA = "Veyra/1.0";

// 探测端点按「成功率高 → 低」排序，且全部做 2xx 校验：
// 之前只看 body 不看状态码，ip-api 的 429 / ipinfo 的 429 都会被当成「解析失败」继续往下试，
// 最后一个 httpbin 在部分节点上又连不通，于是一次启动就整体判成「IP 检测失败」。
// ip-api 免费额度按出口 IP 计（45 次/分），机场共享出口经常 429/临时封禁，
// 所以优先用 HTTPS 的 api.ip.sb / ipwho.is / ifconfig.co / Cloudflare trace，HTTP 接口只兜底。
const EXIT_IP_ENDPOINTS = [
  {
    // 非 CN 段 IP，系统代理开启时必定被规则送进代理；字段也最全。
    // 直连时该站返回 403（被墙），正好快速落到下一个端点。
    url: "https://api.ip.sb/geoip",
    parse(j) {
      if (!j || !j.ip) return null;
      return {
        ip: j.ip,
        country: j.country,
        countryCode: j.country_code,
        city: j.city,
        region: j.region,
        isp: j.isp,
        org: j.organization || j.asn_organization,
        as: j.asn ? `AS${j.asn}` : undefined,
        timezone: j.timezone,
        lat: j.latitude,
        lon: j.longitude,
      };
    },
  },
  {
    url: "https://ipwho.is/",
    parse(j) {
      if (!j || j.success === false || !j.ip) return null;
      const c = j.connection || {};
      return {
        ip: j.ip,
        country: j.country,
        countryCode: j.country_code,
        city: j.city,
        region: j.region,
        isp: c.isp,
        org: c.org,
        as: c.asn ? `AS${c.asn}` : undefined,
        timezone: j.timezone?.id,
        lat: j.latitude,
        lon: j.longitude,
      };
    },
  },
  {
    url: "https://ifconfig.co/json",
    parse(j) {
      if (!j || !j.ip) return null;
      return {
        ip: j.ip,
        country: j.country,
        countryCode: j.country_iso,
        city: j.city,
        region: j.region_name,
        isp: j.asn_org,
        org: j.asn_org,
        as: j.asn ? `AS${j.asn}` : undefined,
        timezone: j.time_zone,
        lat: j.latitude,
        lon: j.longitude,
      };
    },
  },
  {
    // 纯文本 key=value；没有城市/ISP，但胜在稳定且不挑网络
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    parseText(text) {
      const map = {};
      for (const line of String(text).split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      if (!map.ip) return null;
      return { ip: map.ip, countryCode: map.loc };
    },
  },
  {
    url: "http://ip-api.com/json?fields=query,country,countryCode,city,regionName,isp,org,as,timezone,lat,lon",
    parse(j) {
      if (!j || !j.query) return null;
      return {
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
    },
  },
  {
    url: "https://ipinfo.io/json",
    parse(j) {
      if (!j || !j.ip) return null;
      return {
        ip: j.ip,
        country: j.country,
        countryCode: j.countryCode || j.country,
        city: j.city,
        region: j.region,
        isp: j.org,
        org: j.org,
        as: j.asn?.asn,
        timezone: j.timezone,
        lat: j.loc ? Number(j.loc.split(",")[0]) : null,
        lon: j.loc ? Number(j.loc.split(",")[1]) : null,
      };
    },
  },
  {
    url: "http://httpbin.org/ip",
    parse(j) {
      if (!j || !j.origin) return null;
      return { ip: String(j.origin).split(",")[0].trim() };
    },
  },
];

/**
 * 出口 IP 探测。
 * @param {{mixedPort?: number, viaProxy?: boolean, timeout?: number}|number} options
 *   viaProxy=true 走本地混合端口（系统代理开启时，反映「代理后的网络」）；
 *   viaProxy=false 直连（系统代理关闭时，反映当前真实网络）。
 */
async function fetchExitIp(options = {}) {
  const opts = typeof options === "number" ? { mixedPort: options } : options || {};
  const viaProxy = opts.viaProxy !== false && Number(opts.mixedPort) > 0;
  const deadline = Date.now() + (Number(opts.timeout) || 8000);
  for (const ep of EXIT_IP_ENDPOINTS) {
    const remain = deadline - Date.now();
    if (remain < 1200) break;
    const timeout = Math.min(4000, remain);
    try {
      const r = viaProxy
        ? await proxyFetchThrough(ep.url, Number(opts.mixedPort), timeout)
        : await directFetch(ep.url, timeout);
      // 明确丢弃 429/403/5xx：这些响应里的错误 JSON 不是出口信息
      if (r.status < 200 || r.status >= 300) continue;
      const text = r.body.toString("utf8");
      let info = null;
      if (ep.parseText) {
        info = ep.parseText(text);
      } else {
        let j = null;
        try {
          j = JSON.parse(text);
        } catch {
          const m = text.match(/\d{1,3}(?:\.\d{1,3}){3}/);
          if (m) info = { ip: m[0] };
        }
        if (j) info = ep.parse(j);
      }
      if (info && info.ip) return info;
    } catch {}
  }
  return { ip: null };
}

function readResponse(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
  });
}

/** 直连请求（系统代理关闭时用） */
function directFetch(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { Host: u.host, "User-Agent": EXIT_IP_UA, Accept: "application/json" },
        timeout: timeoutMs,
      },
      (res) => readResponse(res).then(resolve, reject)
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

/**
 * 经本地混合端口请求。
 * HTTP 走绝对 URL；HTTPS 必须 CONNECT 建隧道再 TLS —— 直接把 https:// 绝对 URL
 * 发给 HTTP 代理是拿不到响应的（旧实现只敢用 http:// 端点，正是这个原因）。
 */
function proxyFetchThrough(url, proxyPort, timeoutMs) {
  const u = new URL(url);
  if (u.protocol === "http:") {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: url,
          headers: { Host: u.host, "User-Agent": EXIT_IP_UA, Accept: "application/json" },
          timeout: timeoutMs,
        },
        (res) => readResponse(res).then(resolve, reject)
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.end();
    });
  }
  return new Promise((resolve, reject) => {
    const authority = `${u.hostname}:${u.port || 443}`;
    const connectReq = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      headers: { Host: authority },
      timeout: timeoutMs,
    });
    connectReq.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      if (head && head.length) socket.unshift(head);
      // 注意：不能用 agent:false + createConnection —— Node 会忽略 createConnection
      // 直接连目标，等于绕过了代理（实测 HTTPS 请求拿到的是本机出口 IP）。
      // 必须挂一个自定义 Agent，把 CONNECT 隧道 socket 复用为 TLS 底层。
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => tls.connect({ socket, servername: u.hostname });
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: "GET",
          headers: { Host: u.host, "User-Agent": EXIT_IP_UA, Accept: "application/json" },
          agent,
          timeout: timeoutMs,
        },
        (r) => readResponse(r).then(resolve, reject)
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.end();
    });
    connectReq.on("error", reject);
    connectReq.on("timeout", () => {
      connectReq.destroy(new Error("timeout"));
    });
    connectReq.end();
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
