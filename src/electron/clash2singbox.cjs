// Veyra · Clash(YAML 对象) → sing-box(JSON 对象) 转换器（实验性）
// 目标：保证 sing-box 能启动、常用节点/分组/规则可用；不支持的项记 warnings 并安全降级，绝不输出非法字段。
// 注意 sing-box 对未知字段是严格报错的，所以这里只输出确认存在的字段。

function num(v, fb) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/-?\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return fb;
}

function str(v, fb = "") {
  return typeof v === "string" ? v : fb;
}

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// sing-box 对 reality 公钥用 URL-safe 无填充 base64 解码（标准 base64 的 +/ 和 = 会被拒）
function toUrlSafeKey(v) {
  return String(v || "")
    .trim()
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const KNOWN_UTLS = new Set([
  "chrome",
  "firefox",
  "safari",
  "ios",
  "android",
  "edge",
  "360",
  "qq",
  "random",
  "randomized",
]);

function tlsOf(p) {
  const hasTls = p.tls || p["reality-opts"] || p.realityOpts;
  if (!hasTls) return undefined;
  const tls = { enabled: true };
  const sn = pick(p, "sni", "servername");
  if (sn) tls.server_name = String(sn);
  if (p["skip-cert-verify"]) tls.insecure = true;
  if (p.alpn) tls.alpn = Array.isArray(p.alpn) ? p.alpn.map(String) : [String(p.alpn)];
  const reality = pick(p, "reality-opts", "realityOpts");
  if (reality && typeof reality === "object") {
    const r = { enabled: true };
    if (reality["public-key"]) r.public_key = toUrlSafeKey(String(reality["public-key"]));
    if (reality["short-id"] !== undefined) r.short_id = String(reality["short-id"]);
    tls.reality = r;
  }
  const fp = pick(p, "fingerprint", "client-fingerprint");
  if (fp && KNOWN_UTLS.has(String(fp).toLowerCase())) {
    tls.utls = { enabled: true, fingerprint: String(fp).toLowerCase() };
  }
  return tls;
}

function transportOf(p) {
  const net = String(pick(p, "network", "net") || "tcp").toLowerCase();
  if (net === "ws" || net === "websocket") {
    const o = pick(p, "ws-opts", "wsOpts") || {};
    const t = { type: "ws", path: str(o.path, "/") };
    if (o.headers && typeof o.headers === "object") t.headers = o.headers;
    const med = pick(o, "max-early-data");
    if (med !== undefined) t.max_early_data = num(med, 0);
    const edh = pick(o, "early-data-header-name");
    if (edh) t.early_data_header_name = String(edh);
    return t;
  }
  if (net === "h2") {
    const o = pick(p, "h2-opts", "h2Opts") || {};
    const t = { type: "http" };
    if (o.host) t.host = Array.isArray(o.host) ? o.host.map(String) : [String(o.host)];
    if (o.path) t.path = String(o.path);
    return t;
  }
  if (net === "grpc") {
    const o = pick(p, "grpc-opts", "grpcOpts") || {};
    return { type: "grpc", service_name: str(pick(o, "grpc-service-name"), "") };
  }
  if (net === "httpupgrade") {
    const o = pick(p, "httpupgrade-opts", "httpupgradeOpts") || {};
    const t = { type: "httpupgrade", path: str(o.path, "/") };
    if (o.host) t.host = String(o.host);
    if (o.headers && typeof o.headers === "object") t.headers = o.headers;
    return t;
  }
  if (net === "tcp") {
    const o = pick(p, "http-opts", "httpOpts");
    if (o && typeof o === "object") {
      const t = { type: "http" };
      if (o.path) t.path = Array.isArray(o.path) ? String(o.path[0]) : String(o.path);
      if (o.host) t.host = Array.isArray(o.host) ? o.host.map(String) : [String(o.host)];
      if (o.method) t.method = String(o.method);
      return t;
    }
  }
  return undefined;
}

function convertProxy(p, warnings) {
  if (!p || typeof p !== "object") return null;
  const name = str(p.name);
  const type = String(p.type || "").toLowerCase();
  if (!name || !type) return null;
  const server = str(pick(p, "server"));
  const port = num(pick(p, "port"), 0);
  if (!server || !port) {
    warnings.push(`节点 ${name} 缺 server/port，已跳过`);
    return null;
  }
  const base = { tag: name, server, server_port: port };

  switch (type) {
    case "ss":
    case "shadowsocks": {
      if (pick(p, "plugin", "plugin-opts", "pluginOpts")) {
        warnings.push(`节点 ${name} 用了 ss 插件，sing-box 不支持，已跳过`);
        return null;
      }
      return {
        ...base,
        type: "shadowsocks",
        method: str(p.cipher, "none"),
        password: str(p.password),
      };
    }
    case "ssr":
    case "shadowsocksr": {
      warnings.push(`节点 ${name} 是 SSR，sing-box 已不支持，已跳过`);
      return null;
    }
    case "vmess": {
      const o = {
        ...base,
        type: "vmess",
        uuid: str(pick(p, "uuid", "id")),
        alter_id: num(pick(p, "alterId", "alter-id"), 0),
        security: str(pick(p, "cipher", "security"), "auto"),
      };
      const tls = tlsOf(p);
      if (tls) o.tls = tls;
      const tr = transportOf(p);
      if (tr) o.transport = tr;
      return o;
    }
    case "vless": {
      const o = { ...base, type: "vless", uuid: str(pick(p, "uuid", "id")) };
      if (p.flow) o.flow = String(p.flow);
      const xudp = pick(p, "packet-encoding", "packet_encoding", "packetaddr", "xudp");
      if (xudp === "xudp" || p.xudp) o.packet_encoding = "xudp";
      else if (xudp === "packetaddr" || p.packetaddr) o.packet_encoding = "packetaddr";
      const tls = tlsOf(p);
      if (tls) o.tls = tls;
      const tr = transportOf(p);
      if (tr) o.transport = tr;
      return o;
    }
    case "trojan": {
      const o = { ...base, type: "trojan", password: str(p.password) };
      const tls = tlsOf(p) || { enabled: true, server_name: server };
      o.tls = tls;
      const tr = transportOf(p);
      if (tr) o.transport = tr;
      return o;
    }
    case "socks5":
    case "socks": {
      const o = { ...base, type: "socks", version: "5" };
      if (p.username) o.username = String(p.username);
      if (p.password) o.password = String(p.password);
      const tls = tlsOf(p);
      if (tls) o.tls = tls;
      return o;
    }
    case "http": {
      const o = { ...base, type: "http" };
      if (p.username) o.username = String(p.username);
      if (p.password) o.password = String(p.password);
      const tls = tlsOf(p);
      if (tls) o.tls = tls;
      return o;
    }
    case "hysteria": {
      const o = { ...base, type: "hysteria" };
      if (p.ports) {
        // Clash "1000-2000,3000" → sing-box ["1000:2000","3000"]（原样写入会导致 sing-box 启动报错）
        const pp = parsePorts(p.ports);
        const sp = [...pp.ranges, ...pp.ports.map(String)];
        if (sp.length) o.server_ports = sp;
      }
      const up = pick(p, "up", "upmbps");
      const down = pick(p, "down", "downmbps");
      if (up !== undefined) o.up_mbps = num(up, 0);
      if (down !== undefined) o.down_mbps = num(down, 0);
      if (p.obfs) o.obfs = String(typeof p.obfs === "object" ? p.obfs.password || "" : p.obfs);
      const auth = pick(p, "auth-str", "auth_str", "authstr");
      if (auth) o.auth_str = String(auth);
      else if (p.auth) o.auth_str = String(p.auth);
      const tls = tlsOf(p) || {};
      if (!tls.server_name && p.sni) tls.server_name = String(p.sni);
      if (Object.keys(tls).length) {
        tls.enabled = true;
        o.tls = tls;
      }
      return o;
    }
    case "hysteria2":
    case "hy2": {
      const o = {
        ...base,
        type: "hysteria2",
        password: str(pick(p, "password", "auth", "auth-str", "auth_str")),
      };
      const obfs = pick(p, "obfs");
      if (obfs) {
        o.obfs = {
          type: str(typeof obfs === "object" ? obfs.type : obfs, "salamander"),
          password: str(typeof obfs === "object" ? pick(obfs, "password", "obfs-password") : pick(p, "obfs-password", "obfs_password"), ""),
        };
      }
      const tls = tlsOf(p) || { enabled: true };
      if (!tls.server_name) tls.server_name = str(pick(p, "sni"), server);
      o.tls = tls;
      return o;
    }
    case "tuic": {
      const o = { ...base, type: "tuic", uuid: str(p.uuid), password: str(p.password) };
      const cc = pick(p, "congestion-controller", "congestion_control");
      if (cc && ["cubic", "new_reno", "brutal"].includes(String(cc))) {
        o.congestion_control = String(cc);
      }
      const urm = pick(p, "udp-relay-mode", "udp_relay_mode");
      if (urm && ["native", "quic"].includes(String(urm))) o.udp_relay_mode = String(urm);
      if (pick(p, "reduce-rtt", "reduce_rtt")) o.zero_rtt_handshake = true;
      const hb = pick(p, "heartbeat-interval", "heartbeat_interval");
      if (hb) o.heartbeat = String(hb);
      const tls = tlsOf(p) || { enabled: true };
      if (!tls.server_name) tls.server_name = str(pick(p, "sni"), server);
      o.tls = tls;
      return o;
    }
    case "wireguard":
    case "wg": {
      // sing-box 1.13+ 已移除 wireguard 出站（须迁到 endpoint，且无法进选择器/规则）
      warnings.push(`节点 ${name} 是 wireguard，sing-box 1.14 已不再支持出站写法，已跳过`);
      return null;
    }
    case "snell": {
      warnings.push(`节点 ${name} 是 Snell，sing-box 不支持，已跳过`);
      return null;
    }
    default: {
      warnings.push(`节点 ${name} 类型 ${p.type} 不支持，已跳过`);
      return null;
    }
  }
}

const SPECIAL_TAGS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

function emitGroups(clash, validTags, warnings) {
  const raw = Array.isArray(clash["proxy-groups"]) ? clash["proxy-groups"] : [];
  // 不动点迭代：只有成员全部可解析的分组才保留（分组可引用后定义的分组）
  let emittable = new Set();
  for (let round = 0; round < raw.length + 1; round++) {
    let changed = false;
    for (const g of raw) {
      if (!g || emittable.has(g.name)) continue;
      const t = String(g.type || "").toLowerCase();
      if (!["select", "selector", "url-test", "urltest", "fallback", "load-balance", "loadbalance"].includes(t)) {
        continue;
      }
      if (g.use) continue; // provider 分组不支持
      const members = Array.isArray(g.proxies) ? g.proxies : [];
      const ok = members.filter(
        (m) => validTags.has(m) || emittable.has(m) || (SPECIAL_TAGS.has(m) && m !== "PASS")
      );
      if (ok.length > 0) {
        emittable.add(g.name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const out = [];
  let mappedFallback = false;
  let mappedLB = false;
  for (const g of raw) {
    if (!g || !emittable.has(g.name)) {
      if (g && g.name && !g.use && String(g.type || "").toLowerCase() === "relay") {
        warnings.push(`分组 ${g.name} 是 relay，sing-box 无等价类型，已跳过`);
      } else if (g && g.name && g.use) {
        warnings.push(`分组 ${g.name} 引用了外部 provider，暂不支持，已跳过`);
      }
      continue;
    }
    const t = String(g.type || "").toLowerCase();
    const members = (Array.isArray(g.proxies) ? g.proxies : [])
      .map((m) => (m === "PASS" || m === "COMPATIBLE" ? "DIRECT" : m))
      .filter((m) => validTags.has(m) || emittable.has(m));
    if (!members.length) continue;
    const dft = members.includes(g.now) ? g.now : members[0];
    if (t === "select" || t === "selector") {
      out.push({ type: "selector", tag: g.name, outbounds: members, default: dft });
    } else if (t === "url-test" || t === "urltest") {
      const interval = fmtDur(pick(g, "interval"), "10m");
      const o = {
        type: "urltest",
        tag: g.name,
        outbounds: members,
        url: str(g.url, "https://www.gstatic.com/generate_204"),
        interval,
        // sing-box 要求 interval ≤ idle_timeout（默认 idle_timeout 仅 30m），同步之
        idle_timeout: interval,
        tolerance: num(pick(g, "tolerance"), 50),
      };
      out.push(o);
    } else if (t === "fallback" || t === "load-balance" || t === "loadbalance") {
      if (t === "fallback") mappedFallback = true;
      else mappedLB = true;
      out.push({ type: "selector", tag: g.name, outbounds: members, default: dft });
    }
  }
  if (mappedFallback) warnings.push("fallback 分组已降级为手动 selector（语义接近，自动故障转移需手动切换）");
  if (mappedLB) warnings.push("load-balance 分组已降级为手动 selector");
  return out;
}

function fmtDur(v, fb) {
  if (v === undefined || v === null) return fb;
  if (typeof v === "number") return `${v}s`;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return `${s}s`;
  return s || fb;
}

function mapRuleTarget(action, validTags, finalTag) {
  const a = String(action || "").trim();
  if (!a || a === "MATCH") return { useFinal: true };
  if (a === "DIRECT" || a === "PASS" || a === "COMPATIBLE") return { outbound: "DIRECT" };
  if (a === "REJECT" || a === "REJECT-DROP") return { reject: true };
  if (a === "PROXY") return { useFinal: true };
  if (validTags.has(a)) return { outbound: a };
  return { useFinal: true };
}

// Clash 端口串（"80" / "80,443" / "1000-2000"）→ sing-box 的 port(数字)/port_range("a:b")
function parsePorts(payload) {
  const ports = [];
  const ranges = [];
  for (const part of String(payload || "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      ranges.push(`${m[1]}:${m[2]}`);
    } else if (/^\d+$/.test(s)) {
      ports.push(parseInt(s, 10));
    } else if (/^\d+\s*:\s*\d+$/.test(s)) {
      ranges.push(s.replace(/\s+/g, ""));
    }
  }
  return { ports, ranges };
}

// geoip/geosite 在 sing-box 1.12 起移除内置库，改用远程 rule_set（.srs）
function geoRuleSet(kind, payload, ruleSets) {
  const name = String(payload || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@_-]/g, "");
  if (!name) return "";
  const tag = `${kind}-${name}`;
  if (!ruleSets.has(tag)) {
    const repo = kind === "geoip" ? "sing-geoip" : "sing-geosite";
    ruleSets.set(tag, {
      type: "remote",
      tag,
      format: "binary",
      url: `https://raw.githubusercontent.com/SagerNet/${repo}/rule-set/${tag}.srs`,
      // 规则集直连下载：不依赖代理可用性，也消除 1.14 的隐式默认出站弃用告警
      download_detour: "DIRECT",
    });
  }
  return tag;
}

function convertRules(clash, validTags, finalTag, warnings, ruleSets) {
  const raw = Array.isArray(clash.rules) ? clash.rules : [];
  const out = [];
  let skipped = 0;
  for (const line of raw) {
    if (typeof line !== "string" || !line.trim()) continue;
    const rawParts = line.split(",").map((s) => s.trim());
    // 先剥离尾部 no-resolve 修饰符再解析（它只是修饰，不是策略）。
    // 旧实现把 "IP-CIDR,1.1.1.0/24,no-resolve" 这类无策略规则误解析成
    // payload="" + action="1.1.1.0/24"，会生成 ip_cidr:[""] 的非法规则导致 sing-box 启动失败。
    const parts =
      rawParts.length > 2 && rawParts[rawParts.length - 1].toLowerCase() === "no-resolve"
        ? rawParts.slice(0, -1)
        : rawParts;
    if (parts.length < 2) {
      skipped++;
      continue;
    }
    const type = parts[0].toUpperCase();
    const payload = parts.length >= 3 ? parts.slice(1, -1).join(",") : parts[1];
    const action = parts.length >= 3 ? parts[parts.length - 1] : "MATCH";
    if (!payload) {
      skipped++;
      continue;
    }
    const tgt = mapRuleTarget(action, validTags);
    const rule = {};
    if (tgt.reject) rule.action = "reject";
    else if (!tgt.useFinal && tgt.outbound) rule.outbound = tgt.outbound;
    else rule.outbound = finalTag;

    let ok = true;
    switch (type) {
      case "DOMAIN":
        rule.domain = [payload];
        break;
      case "DOMAIN-SUFFIX":
        rule.domain_suffix = [payload];
        break;
      case "DOMAIN-KEYWORD":
        rule.domain_keyword = [payload];
        break;
      case "DOMAIN-REGEX":
        rule.domain_regex = [payload];
        break;
      case "IP-CIDR":
      case "IP-CIDR6":
        rule.ip_cidr = [payload];
        break;
      case "SRC-IP-CIDR":
        rule.source_ip_cidr = [payload];
        break;
      case "DST-PORT":
      case "DST-PORTS": {
        const { ports, ranges } = parsePorts(payload);
        if (ports.length) rule.port = ports;
        if (ranges.length) rule.port_range = ranges;
        if (!ports.length && !ranges.length) ok = false;
        break;
      }
      case "SRC-PORT":
      case "SRC-PORTS": {
        const { ports, ranges } = parsePorts(payload);
        if (ports.length) rule.source_port = ports;
        if (ranges.length) rule.source_port_range = ranges;
        if (!ports.length && !ranges.length) ok = false;
        break;
      }
      case "GEOIP": {
        const tag = geoRuleSet("geoip", payload, ruleSets);
        if (!tag) ok = false;
        else rule.rule_set = [tag];
        break;
      }
      case "GEOSITE": {
        const tag = geoRuleSet("geosite", payload, ruleSets);
        if (!tag) ok = false;
        else rule.rule_set = [tag];
        break;
      }
      case "PROCESS-NAME":
        rule.process_name = [payload];
        break;
      case "PROCESS-PATH":
        rule.process_path = [payload];
        break;
      case "MATCH":
        continue; // final 兜底已覆盖
      default:
        skipped++;
        ok = false;
        break;
    }
    if (ok) out.push(rule);
  }
  if (skipped > 0) warnings.push(`${skipped} 条规则暂不支持（RULE-SET/复合规则等），已跳过`);
  return out;
}

function convertClashToSingbox(clash, opts = {}) {
  const warnings = [];
  const c = clash && typeof clash === "object" ? clash : {};
  const mixedPort = num(opts.mixedPort, 17897);
  const ctrlHost = str(opts.controllerHost, "127.0.0.1");
  const ctrlPort = num(opts.controllerPort, 19097);
  const secret = str(opts.secret, "");
  const allowLan = !!opts.allowLan;
  const logLevel = { silent: "panic", error: "error", warning: "warn", info: "info", debug: "debug" }[
    str(opts.logLevel, "info")
  ] || "info";

  // ---- 出站（节点） ----
  const rawProxies = Array.isArray(c.proxies) ? c.proxies : [];
  const outbounds = [];
  const proxyTags = new Set();
  let skippedNodes = 0;
  for (const p of rawProxies) {
    const o = convertProxy(p, warnings);
    if (o && !proxyTags.has(o.tag)) {
      outbounds.push(o);
      proxyTags.add(o.tag);
    } else if (!o) {
      skippedNodes++;
    }
  }
  const validTags = new Set([...proxyTags, "DIRECT", "REJECT", "REJECT-DROP"]);

  // ---- 分组 ----
  const groupObjs = emitGroups(c, validTags, warnings);
  for (const g of groupObjs) {
    outbounds.push(g);
    validTags.add(g.tag);
  }

  // ---- 保底出站 ----
  outbounds.push({ type: "direct", tag: "DIRECT" });
  outbounds.push({ type: "block", tag: "REJECT" });
  outbounds.push({ type: "block", tag: "REJECT-DROP" });

  // route.final：优先 PROXY，否则第一个分组，否则第一个节点，否则 DIRECT
  let finalTag = "DIRECT";
  if (validTags.has("PROXY")) finalTag = "PROXY";
  else if (groupObjs.length) finalTag = groupObjs[0].tag;
  else if (outbounds.length && proxyTags.size) finalTag = [...proxyTags][0];

  // ---- 路由规则 ----
  const ruleSets = new Map();
  const routeRules = convertRules(c, validTags, finalTag, warnings, ruleSets);

  // ---- DNS ----
  const firstProxy = [...proxyTags][0] || "";
  // sing-box ≥1.12 的新 DNS 写法（旧字符串格式在 1.14 已移除）
  const dnsServers = [];
  if (firstProxy) {
    dnsServers.push({ tag: "dns-proxy", type: "tls", server: "8.8.8.8", detour: firstProxy });
  }
  dnsServers.push({ tag: "dns-direct", type: "udp", server: "223.5.5.5" });

  const config = {
    log: { level: logLevel, timestamp: true },
    dns: {
      servers: dnsServers,
      rules: [
        { clash_mode: "Direct", server: "dns-direct" },
        ...(firstProxy ? [{ clash_mode: "Global", server: "dns-proxy" }] : []),
      ],
      final: "dns-direct",
    },
    inbounds: [
      {
        type: "mixed",
        tag: "mixed-in",
        listen: allowLan ? "0.0.0.0" : "127.0.0.1",
        listen_port: mixedPort,
      },
    ],
    outbounds,
    route: {
      ...(ruleSets.size ? { rule_set: [...ruleSets.values()] } : {}),
      rules: routeRules,
      final: finalTag,
      default_domain_resolver: "dns-direct",
    },
    experimental: {
      clash_api: {
        external_controller: `${ctrlHost}:${ctrlPort}`,
        ...(secret ? { secret } : {}),
        default_mode: "Rule",
      },
    },
  };

  return {
    config,
    warnings,
    stats: {
      nodes: proxyTags.size,
      skippedNodes,
      groups: groupObjs.length,
      rules: routeRules.length,
      final: finalTag,
    },
  };
}

module.exports = { convertClashToSingbox };
