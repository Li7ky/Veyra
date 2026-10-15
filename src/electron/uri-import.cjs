/**
 * 完整单节点 URI → Clash Meta proxy 对象
 * 支持 ss / ssr / vmess / vless / trojan / hysteria2 / tuic
 */
const crypto = require("crypto");

function b64decode(s) {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? t : t + "=".repeat(4 - (t.length % 4));
  return Buffer.from(pad, "base64").toString("utf8");
}

function parseQuery(q) {
  const out = {};
  if (!q) return out;
  for (const part of String(q).replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const [k, ...rest] = part.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function safeName(n, fallback) {
  const s = String(n || fallback || "node")
    .trim()
    .replace(/[/\\:*?"<>|]/g, "_")
    .slice(0, 64);
  return s || fallback || "node";
}

function parseSs(uri) {
  // ss://base64(method:pass@host:port)#name  OR ss://method:pass@host:port#name
  let rest = uri.slice(5);
  let name = "ss-node";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = decodeURIComponent(rest.slice(hash + 1)) || name;
    rest = rest.slice(0, hash);
  }
  let userinfo;
  let hostport;
  if (rest.includes("@")) {
    // maybe already decoded or method:pass@host:port
    try {
      if (!rest.includes(":")) rest = b64decode(rest);
    } catch {}
    const at = rest.lastIndexOf("@");
    userinfo = rest.slice(0, at);
    hostport = rest.slice(at + 1);
    if (!userinfo.includes(":")) userinfo = b64decode(userinfo);
  } else {
    const decoded = b64decode(rest);
    const at = decoded.lastIndexOf("@");
    userinfo = decoded.slice(0, at);
    hostport = decoded.slice(at + 1);
  }
  const [method, ...pwParts] = userinfo.split(":");
  const password = pwParts.join(":");
  const [server, port] = hostport.split(":");
  return {
    name: safeName(name, "ss"),
    type: "ss",
    server,
    port: Number(port) || 443,
    cipher: method,
    password,
    udp: true,
  };
}

function parseVmess(uri) {
  // vmess://base64(json)
  const raw = b64decode(uri.slice(8));
  const j = JSON.parse(raw);
  const proxy = {
    name: safeName(j.ps || j.remark || j.name, "vmess"),
    type: "vmess",
    server: j.add || j.server,
    port: Number(j.port) || 443,
    uuid: j.id,
    alterId: Number(j.aid ?? j.alterId ?? 0),
    cipher: j.scy || "auto",
    udp: true,
    tls: j.tls === "tls" || j.tls === true,
    servername: j.sni || j.host || undefined,
    network: j.net || "tcp",
  };
  if (j.net === "ws") {
    proxy["ws-opts"] = {
      path: j.path || "/",
      headers: j.host ? { Host: j.host } : undefined,
    };
  }
  if (j.net === "grpc") {
    proxy["grpc-opts"] = { "grpc-service-name": j.path || "" };
  }
  return proxy;
}

function parseVless(uri) {
  // vless://uuid@host:port?params#name
  const u = new URL(uri);
  const q = parseQuery(u.search);
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || "vless";
  const proxy = {
    name: safeName(name, "vless"),
    type: "vless",
    server: u.hostname,
    port: Number(u.port) || 443,
    uuid: decodeURIComponent(u.username),
    udp: true,
    tls: q.security === "tls" || q.security === "reality",
    servername: q.sni || undefined,
    flow: q.flow || undefined,
    network: q.type || "tcp",
    "client-fingerprint": q.fp || undefined,
  };
  if (q.security === "reality") {
    proxy["reality-opts"] = {
      "public-key": q.pbk || "",
      "short-id": q.sid || "",
    };
  }
  if (q.type === "ws") {
    proxy["ws-opts"] = { path: q.path || "/", headers: q.host ? { Host: q.host } : undefined };
  }
  if (q.type === "grpc") {
    proxy["grpc-opts"] = { "grpc-service-name": q.serviceName || q.path || "" };
  }
  return proxy;
}

function parseTrojan(uri) {
  const u = new URL(uri);
  const q = parseQuery(u.search);
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || "trojan";
  const proxy = {
    name: safeName(name, "trojan"),
    type: "trojan",
    server: u.hostname,
    port: Number(u.port) || 443,
    password: decodeURIComponent(u.username),
    udp: true,
    sni: q.sni || u.hostname,
    network: q.type || "tcp",
  };
  if (q.type === "ws") {
    proxy["ws-opts"] = { path: q.path || "/", headers: q.host ? { Host: q.host } : undefined };
  }
  return proxy;
}

function parseHysteria2(uri) {
  // hysteria2://pass@host:port?params#name
  const u = new URL(uri.replace(/^hy2:/i, "hysteria2:"));
  const q = parseQuery(u.search);
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || "hysteria2";
  return {
    name: safeName(name, "hysteria2"),
    type: "hysteria2",
    server: u.hostname,
    port: Number(u.port) || 443,
    password: decodeURIComponent(u.username),
    sni: q.sni || undefined,
    "skip-cert-verify": q.insecure === "1" || q.insecure === "true",
  };
}

function parseTuic(uri) {
  const u = new URL(uri);
  const q = parseQuery(u.search);
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || "tuic";
  return {
    name: safeName(name, "tuic"),
    type: "tuic",
    server: u.hostname,
    port: Number(u.port) || 443,
    uuid: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || q.password || ""),
    sni: q.sni || undefined,
    "congestion-controller": q.congestion_control || "bbr",
    "udp-relay-mode": q.udp_relay_mode || "native",
  };
}

function parseNodeUri(uri) {
  const u = String(uri || "").trim();
  if (!u) throw new Error("空 URI");
  let proxy;
  if (/^ss:\/\//i.test(u)) proxy = parseSs(u);
  else if (/^vmess:\/\//i.test(u)) proxy = parseVmess(u);
  else if (/^vless:\/\//i.test(u)) proxy = parseVless(u);
  else if (/^trojan:\/\//i.test(u)) proxy = parseTrojan(u);
  else if (/^(hysteria2|hy2):\/\//i.test(u)) proxy = parseHysteria2(u);
  else if (/^tuic:\/\//i.test(u)) proxy = parseTuic(u);
  else throw new Error("不支持的节点 URI 协议");

  // 清理 undefined
  for (const k of Object.keys(proxy)) {
    if (proxy[k] === undefined) delete proxy[k];
  }
  return proxy;
}

function proxyToYamlDoc(proxy) {
  const yaml = require("js-yaml");
  const name = proxy.name;
  const doc = {
    proxies: [proxy],
    "proxy-groups": [
      {
        name: "PROXY",
        type: "select",
        proxies: [name, "DIRECT"],
      },
    ],
    rules: ["MATCH,PROXY"],
  };
  return {
    name,
    type: proxy.type,
    content: yaml.dump(doc, { lineWidth: -1, noRefs: true }),
    proxy,
  };
}

// 信息节点（机场用来展示流量/到期时间的假节点），不转成代理
const INFO_NAME_RE = /剩余流量|已用流量|套餐到期|距离.*重置|到期时间|流量.*GB|有效期/i;
function isInfoNode(name) {
  return INFO_NAME_RE.test(String(name || ""));
}

// 多条节点 URI -> 完整 Clash YAML（含去重名、过滤信息节点）
function urisToYamlDoc(uris) {
  const yaml = require("js-yaml");
  const proxies = [];
  const seen = new Set();
  for (const u of uris) {
    let p;
    try {
      p = parseNodeUri(u);
    } catch {
      continue;
    }
    if (!p || !p.server || !p.name || isInfoNode(p.name)) continue;
    let name = p.name;
    let i = 2;
    while (seen.has(name)) name = `${p.name} ${i++}`;
    seen.add(name);
    p.name = name;
    proxies.push(p);
  }
  if (!proxies.length) throw new Error("节点列表为空或全部无法解析");
  const names = proxies.map((p) => p.name);
  const doc = {
    proxies,
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: [...names, "DIRECT"] },
      {
        name: "自动选择",
        type: "url-test",
        proxies: names,
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
      },
    ],
    rules: ["MATCH,PROXY"],
  };
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

module.exports = { parseNodeUri, proxyToYamlDoc, urisToYamlDoc, safeName };