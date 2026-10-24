//! Clash YAML 对象 → sing-box JSON 配置（对齐 Electron clash2singbox.cjs）。
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn num(v: Option<&Value>, fb: f64) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(fb),
        Some(Value::String(s)) => {
            let re = regex::Regex::new(r"-?\d+(\.\d+)?").unwrap();
            re.find(s)
                .and_then(|m| m.as_str().parse::<f64>().ok())
                .unwrap_or(fb)
        }
        _ => fb,
    }
}

fn num_u(v: Option<&Value>, fb: u64) -> u64 {
    num(v, fb as f64).max(0.0) as u64
}

fn str_of(v: Option<&Value>, fb: &str) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => fb.to_string(),
    }
}

fn pick<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let map = obj.as_object()?;
    for k in keys {
        if let Some(v) = map.get(*k) {
            if !v.is_null() {
                return Some(v);
            }
        }
    }
    None
}

fn to_url_safe_key(s: &str) -> String {
    s.trim()
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

const KNOWN_UTLS: &[&str] = &[
    "chrome", "firefox", "safari", "ios", "android", "edge", "360", "qq", "random", "randomized",
];

fn tls_of(p: &Value) -> Option<Value> {
    let has_tls = p.get("tls").and_then(|v| v.as_bool()).unwrap_or(false)
        || p.get("reality-opts").is_some()
        || p.get("realityOpts").is_some();
    if !has_tls {
        return None;
    }
    let mut tls = Map::new();
    tls.insert("enabled".into(), json!(true));
    if let Some(sn) = pick(p, &["sni", "servername"]) {
        tls.insert("server_name".into(), json!(str_of(Some(sn), "")));
    }
    if p.get("skip-cert-verify").and_then(|v| v.as_bool()).unwrap_or(false) {
        tls.insert("insecure".into(), json!(true));
    }
    if let Some(alpn) = p.get("alpn") {
        let arr = match alpn {
            Value::Array(a) => a.iter().map(|v| json!(str_of(Some(v), ""))).collect(),
            _ => vec![json!(str_of(Some(alpn), ""))],
        };
        tls.insert("alpn".into(), Value::Array(arr));
    }
    if let Some(reality) = pick(p, &["reality-opts", "realityOpts"]) {
        if reality.is_object() {
            let mut r = Map::new();
            r.insert("enabled".into(), json!(true));
            if let Some(pk) = reality.get("public-key") {
                r.insert("public_key".into(), json!(to_url_safe_key(&str_of(Some(pk), ""))));
            }
            if let Some(sid) = reality.get("short-id") {
                r.insert("short_id".into(), json!(str_of(Some(sid), "")));
            }
            tls.insert("reality".into(), Value::Object(r));
        }
    }
    if let Some(fp) = pick(p, &["fingerprint", "client-fingerprint"]) {
        let fp = str_of(Some(fp), "").to_lowercase();
        if KNOWN_UTLS.contains(&fp.as_str()) {
            tls.insert(
                "utls".into(),
                json!({ "enabled": true, "fingerprint": fp }),
            );
        }
    }
    Some(Value::Object(tls))
}

fn transport_of(p: &Value) -> Option<Value> {
    let net = str_of(pick(p, &["network", "net"]), "tcp").to_lowercase();
    match net.as_str() {
        "ws" | "websocket" => {
            let o = pick(p, &["ws-opts", "wsOpts"]).cloned().unwrap_or_else(|| json!({}));
            let mut t = Map::new();
            t.insert("type".into(), json!("ws"));
            t.insert("path".into(), json!(str_of(o.get("path"), "/")));
            if let Some(h) = o.get("headers") {
                if h.is_object() {
                    t.insert("headers".into(), h.clone());
                }
            }
            if let Some(v) = pick(&o, &["max-early-data"]) {
                t.insert("max_early_data".into(), json!(num_u(Some(v), 0)));
            }
            if let Some(v) = pick(&o, &["early-data-header-name"]) {
                t.insert("early_data_header_name".into(), json!(str_of(Some(v), "")));
            }
            Some(Value::Object(t))
        }
        "h2" => {
            let o = pick(p, &["h2-opts", "h2Opts"]).cloned().unwrap_or_else(|| json!({}));
            let mut t = Map::new();
            t.insert("type".into(), json!("http"));
            if let Some(h) = o.get("host") {
                let hosts = match h {
                    Value::Array(a) => a.iter().map(|v| json!(str_of(Some(v), ""))).collect(),
                    _ => vec![json!(str_of(Some(h), ""))],
                };
                t.insert("host".into(), Value::Array(hosts));
            }
            if let Some(path) = o.get("path") {
                t.insert("path".into(), json!(str_of(Some(path), "")));
            }
            Some(Value::Object(t))
        }
        "grpc" => {
            let o = pick(p, &["grpc-opts", "grpcOpts"]).cloned().unwrap_or_else(|| json!({}));
            Some(json!({
                "type": "grpc",
                "service_name": str_of(pick(&o, &["grpc-service-name"]), ""),
            }))
        }
        "httpupgrade" => {
            let o = pick(p, &["httpupgrade-opts", "httpupgradeOpts"])
                .cloned()
                .unwrap_or_else(|| json!({}));
            let mut t = Map::new();
            t.insert("type".into(), json!("httpupgrade"));
            t.insert("path".into(), json!(str_of(o.get("path"), "/")));
            if let Some(h) = o.get("host") {
                t.insert("host".into(), json!(str_of(Some(h), "")));
            }
            if let Some(h) = o.get("headers") {
                if h.is_object() {
                    t.insert("headers".into(), h.clone());
                }
            }
            Some(Value::Object(t))
        }
        "tcp" => {
            let o = pick(p, &["http-opts", "httpOpts"])?;
            if !o.is_object() {
                return None;
            }
            let mut t = Map::new();
            t.insert("type".into(), json!("http"));
            if let Some(path) = o.get("path") {
                let path = match path {
                    Value::Array(a) => a.first().map(|v| str_of(Some(v), "")).unwrap_or_default(),
                    _ => str_of(Some(path), ""),
                };
                t.insert("path".into(), json!(path));
            }
            if let Some(h) = o.get("host") {
                let hosts = match h {
                    Value::Array(a) => a.iter().map(|v| json!(str_of(Some(v), ""))).collect(),
                    _ => vec![json!(str_of(Some(h), ""))],
                };
                t.insert("host".into(), Value::Array(hosts));
            }
            if let Some(m) = o.get("method") {
                t.insert("method".into(), json!(str_of(Some(m), "")));
            }
            Some(Value::Object(t))
        }
        _ => None,
    }
}

fn convert_proxy(p: &Value, warnings: &mut Vec<String>) -> Option<Value> {
    let name = str_of(p.get("name"), "");
    let ty = str_of(p.get("type"), "").to_lowercase();
    if name.is_empty() || ty.is_empty() {
        return None;
    }
    let server = str_of(pick(p, &["server"]), "");
    let port = num(pick(p, &["port"]), 0.0) as u64;
    if server.is_empty() || port == 0 {
        warnings.push(format!("节点 {} 缺 server/port，已跳过", name));
        return None;
    }
    let mut base = Map::new();
    base.insert("tag".into(), json!(name));
    base.insert("server".into(), json!(server));
    base.insert("server_port".into(), json!(port));
    let mut with = |ty_name: &str| -> Map<String, Value> {
        let mut m = base.clone();
        m.insert("type".into(), json!(ty_name));
        m
    };

    match ty.as_str() {
        "ss" | "shadowsocks" => {
            if pick(p, &["plugin", "plugin-opts", "pluginOpts"]).is_some() {
                warnings.push(format!("节点 {} 用了 ss 插件，sing-box 不支持，已跳过", name));
                return None;
            }
            let mut o = with("shadowsocks");
            o.insert("method".into(), json!(str_of(p.get("cipher"), "none")));
            o.insert("password".into(), json!(str_of(p.get("password"), "")));
            Some(Value::Object(o))
        }
        "ssr" | "shadowsocksr" => {
            warnings.push(format!("节点 {} 是 SSR，sing-box 已不支持，已跳过", name));
            None
        }
        "vmess" => {
            let mut o = with("vmess");
            o.insert("uuid".into(), json!(str_of(pick(p, &["uuid", "id"]), "")));
            o.insert("alter_id".into(), json!(num_u(pick(p, &["alterId", "alter-id"]), 0)));
            o.insert("security".into(), json!(str_of(pick(p, &["cipher", "security"]), "auto")));
            if let Some(tls) = tls_of(p) {
                o.insert("tls".into(), tls);
            }
            if let Some(tr) = transport_of(p) {
                o.insert("transport".into(), tr);
            }
            Some(Value::Object(o))
        }
        "vless" => {
            let mut o = with("vless");
            o.insert("uuid".into(), json!(str_of(pick(p, &["uuid", "id"]), "")));
            if let Some(flow) = p.get("flow") {
                o.insert("flow".into(), json!(str_of(Some(flow), "")));
            }
            let xudp = pick(p, &["packet-encoding", "packet_encoding", "packetaddr", "xudp"])
                .map(|v| str_of(Some(v), ""))
                .unwrap_or_default();
            if xudp == "xudp" || p.get("xudp").and_then(|v| v.as_bool()).unwrap_or(false) {
                o.insert("packet_encoding".into(), json!("xudp"));
            } else if xudp == "packetaddr"
                || p.get("packetaddr").and_then(|v| v.as_bool()).unwrap_or(false)
            {
                o.insert("packet_encoding".into(), json!("packetaddr"));
            }
            if let Some(tls) = tls_of(p) {
                o.insert("tls".into(), tls);
            }
            if let Some(tr) = transport_of(p) {
                o.insert("transport".into(), tr);
            }
            Some(Value::Object(o))
        }
        "trojan" => {
            let mut o = with("trojan");
            o.insert("password".into(), json!(str_of(p.get("password"), "")));
            let tls = tls_of(p).unwrap_or_else(|| json!({ "enabled": true, "server_name": server }));
            o.insert("tls".into(), tls);
            if let Some(tr) = transport_of(p) {
                o.insert("transport".into(), tr);
            }
            Some(Value::Object(o))
        }
        "socks5" | "socks" => {
            let mut o = with("socks");
            o.insert("version".into(), json!("5"));
            if let Some(u) = p.get("username") {
                o.insert("username".into(), json!(str_of(Some(u), "")));
            }
            if let Some(pw) = p.get("password") {
                o.insert("password".into(), json!(str_of(Some(pw), "")));
            }
            if let Some(tls) = tls_of(p) {
                o.insert("tls".into(), tls);
            }
            Some(Value::Object(o))
        }
        "http" => {
            let mut o = with("http");
            if let Some(u) = p.get("username") {
                o.insert("username".into(), json!(str_of(Some(u), "")));
            }
            if let Some(pw) = p.get("password") {
                o.insert("password".into(), json!(str_of(Some(pw), "")));
            }
            if let Some(tls) = tls_of(p) {
                o.insert("tls".into(), tls);
            }
            Some(Value::Object(o))
        }
        "hysteria" => {
            let mut o = with("hysteria");
            if let Some(ports) = p.get("ports") {
                let (pp, ranges) = parse_ports(&str_of(Some(ports), ""));
                let mut sp: Vec<String> = ranges;
                sp.extend(pp.iter().map(|p| p.to_string()));
                if !sp.is_empty() {
                    o.insert("server_ports".into(), json!(sp));
                }
            }
            if let Some(up) = pick(p, &["up", "upmbps"]) {
                o.insert("up_mbps".into(), json!(num_u(Some(up), 0)));
            }
            if let Some(down) = pick(p, &["down", "downmbps"]) {
                o.insert("down_mbps".into(), json!(num_u(Some(down), 0)));
            }
            if let Some(obfs) = p.get("obfs") {
                let val = if obfs.is_object() {
                    str_of(obfs.get("password"), "")
                } else {
                    str_of(Some(obfs), "")
                };
                o.insert("obfs".into(), json!(val));
            }
            let auth = pick(p, &["auth-str", "auth_str", "authstr"])
                .or_else(|| p.get("auth"));
            if let Some(a) = auth {
                o.insert("auth_str".into(), json!(str_of(Some(a), "")));
            }
            // hysteria 的 TLS 是协议隐式必需，订阅通常不写 tls: true；
            // 不注入默认值会生成缺 tls 的出站，导致整份 sing-box 配置加载失败。
            let mut tls = tls_of(p).unwrap_or_else(|| json!({ "enabled": true }));
            if tls.get("server_name").is_none() {
                tls["server_name"] = json!(str_of(pick(p, &["sni"]), &server));
            }
            o.insert("tls".into(), tls);
            Some(Value::Object(o))
        }
        "hysteria2" | "hy2" => {
            let mut o = with("hysteria2");
            o.insert(
                "password".into(),
                json!(str_of(
                    pick(p, &["password", "auth", "auth-str", "auth_str"]),
                    ""
                )),
            );
            if let Some(ports) = p.get("ports") {
                let (pp, ranges) = parse_ports(&str_of(Some(ports), ""));
                let mut sp: Vec<String> = ranges;
                sp.extend(pp.iter().map(|p| p.to_string()));
                if !sp.is_empty() {
                    o.insert("server_ports".into(), json!(sp));
                }
            }
            if let Some(obfs) = p.get("obfs") {
                let (ot, op) = if obfs.is_object() {
                    (
                        str_of(obfs.get("type"), "salamander"),
                        str_of(pick(obfs, &["password", "obfs-password"]), ""),
                    )
                } else {
                    (
                        "salamander".to_string(),
                        str_of(pick(p, &["obfs-password", "obfs_password"]), ""),
                    )
                };
                o.insert("obfs".into(), json!({ "type": ot, "password": op }));
            }
            let mut tls = tls_of(p).unwrap_or_else(|| json!({ "enabled": true }));
            if tls.get("server_name").is_none() {
                tls["server_name"] = json!(str_of(pick(p, &["sni"]), &server));
            }
            o.insert("tls".into(), tls);
            Some(Value::Object(o))
        }
        "tuic" => {
            let mut o = with("tuic");
            o.insert("uuid".into(), json!(str_of(p.get("uuid"), "")));
            o.insert("password".into(), json!(str_of(p.get("password"), "")));
            if let Some(cc) = pick(p, &["congestion-controller", "congestion_control"]) {
                let cc = str_of(Some(cc), "");
                if ["cubic", "new_reno", "brutal"].contains(&cc.as_str()) {
                    o.insert("congestion_control".into(), json!(cc));
                }
            }
            if let Some(urm) = pick(p, &["udp-relay-mode", "udp_relay_mode"]) {
                let urm = str_of(Some(urm), "");
                if ["native", "quic"].contains(&urm.as_str()) {
                    o.insert("udp_relay_mode".into(), json!(urm));
                }
            }
            if pick(p, &["reduce-rtt", "reduce_rtt"])
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                o.insert("zero_rtt_handshake".into(), json!(true));
            }
            if let Some(hb) = pick(p, &["heartbeat-interval", "heartbeat_interval"]) {
                // Clash 的 heartbeat-interval 是毫秒数；sing-box 的 heartbeat 是
                // Go duration 字符串，直接塞 "3000" 会被拒或语义错误。
                let ms = num_u(Some(hb), 0);
                if ms > 0 {
                    o.insert("heartbeat".into(), json!(format!("{}ms", ms)));
                }
            }
            let mut tls = tls_of(p).unwrap_or_else(|| json!({ "enabled": true }));
            if tls.get("server_name").is_none() {
                tls["server_name"] = json!(str_of(pick(p, &["sni"]), &server));
            }
            o.insert("tls".into(), tls);
            Some(Value::Object(o))
        }
        "wireguard" | "wg" => {
            warnings.push(format!(
                "节点 {} 是 wireguard，sing-box 1.14 已不再支持出站写法，已跳过",
                name
            ));
            None
        }
        "snell" => {
            warnings.push(format!("节点 {} 是 Snell，sing-box 不支持，已跳过", name));
            None
        }
        _ => {
            warnings.push(format!("节点 {} 类型 {} 不支持，已跳过", name, ty));
            None
        }
    }
}

fn special_tag(t: &str) -> bool {
    matches!(t, "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "COMPATIBLE")
}

fn fmt_dur(v: Option<&Value>, fb: &str) -> String {
    let Some(v) = v else { return fb.to_string() };
    match v {
        Value::Number(n) => format!("{}s", n),
        Value::String(s) => {
            let s = s.trim();
            if s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty() {
                format!("{}s", s)
            } else if s.is_empty() {
                fb.to_string()
            } else {
                s.to_string()
            }
        }
        _ => fb.to_string(),
    }
}

fn emit_groups(
    clash: &Value,
    valid: &HashSet<String>,
    warnings: &mut Vec<String>,
) -> Vec<Value> {
    let raw = clash
        .get("proxy-groups")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut emittable: HashSet<String> = HashSet::new();
    for _ in 0..=raw.len() {
        let mut changed = false;
        for g in &raw {
            let Some(name) = g.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            if emittable.contains(name) {
                continue;
            }
            let t = str_of(g.get("type"), "").to_lowercase();
            if !matches!(
                t.as_str(),
                "select" | "selector" | "url-test" | "urltest" | "fallback" | "load-balance" | "loadbalance"
            ) {
                continue;
            }
            if g.get("use").is_some() {
                continue;
            }
            let members: Vec<String> = g
                .get("proxies")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().map(|m| str_of(Some(m), "")).collect())
                .unwrap_or_default();
            let ok = members.iter().any(|m| {
                valid.contains(m) || emittable.contains(m) || (special_tag(m) && m != "PASS")
            });
            if ok {
                emittable.insert(name.to_string());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut out = Vec::new();
    let mut mapped_fallback = false;
    let mut mapped_lb = false;
    for g in &raw {
        let Some(name) = g.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if !emittable.contains(name) {
            let t = str_of(g.get("type"), "").to_lowercase();
            if g.get("use").is_some() {
                warnings.push(format!("分组 {} 引用了外部 provider，暂不支持，已跳过", name));
            } else if t == "relay" {
                warnings.push(format!("分组 {} 是 relay，sing-box 无等价类型，已跳过", name));
            }
            continue;
        }
        let t = str_of(g.get("type"), "").to_lowercase();
        let members: Vec<String> = g
            .get("proxies")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|m| str_of(Some(m), "")).collect::<Vec<String>>())
            .unwrap_or_default()
            .into_iter()
            .map(|m| if m == "PASS" || m == "COMPATIBLE" { "DIRECT".to_string() } else { m })
            .filter(|m| valid.contains(m) || emittable.contains(m))
            .collect();
        if members.is_empty() {
            continue;
        }
        let now = g.get("now").and_then(|v| v.as_str()).unwrap_or("");
        let default = if members.iter().any(|m| m == now) {
            now.to_string()
        } else {
            members[0].clone()
        };
        match t.as_str() {
            "select" | "selector" => out.push(json!({
                "type": "selector", "tag": name, "outbounds": members, "default": default,
            })),
            "url-test" | "urltest" => {
                let interval = fmt_dur(g.get("interval"), "10m");
                out.push(json!({
                    "type": "urltest",
                    "tag": name,
                    "outbounds": members,
                    "url": str_of(g.get("url"), "https://www.gstatic.com/generate_204"),
                    "interval": interval,
                    "idle_timeout": interval,
                    "tolerance": num_u(g.get("tolerance"), 50),
                }));
            }
            "fallback" | "load-balance" | "loadbalance" => {
                if t == "fallback" {
                    mapped_fallback = true;
                } else {
                    mapped_lb = true;
                }
                out.push(json!({
                    "type": "selector", "tag": name, "outbounds": members, "default": default,
                }));
            }
            _ => {}
        }
    }
    if mapped_fallback {
        warnings.push("fallback 分组已降级为手动 selector（语义接近，自动故障转移需手动切换）".into());
    }
    if mapped_lb {
        warnings.push("load-balance 分组已降级为手动 selector".into());
    }
    out
}

fn parse_ports(payload: &str) -> (Vec<u64>, Vec<String>) {
    let mut ports = Vec::new();
    let mut ranges = Vec::new();
    let re_range = regex::Regex::new(r"^(\d+)\s*-\s*(\d+)$").unwrap();
    let re_range2 = regex::Regex::new(r"^(\d+)\s*:\s*(\d+)$").unwrap();
    for part in payload.split(',') {
        let s = part.trim();
        if s.is_empty() {
            continue;
        }
        if let Some(c) = re_range.captures(s) {
            ranges.push(format!("{}:{}", &c[1], &c[2]));
        } else if s.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(p) = s.parse::<u64>() {
                ports.push(p);
            }
        } else if let Some(c) = re_range2.captures(s) {
            ranges.push(format!("{}:{}", &c[1], &c[2]));
        }
    }
    (ports, ranges)
}

fn geo_rule_set(kind: &str, payload: &str, sets: &mut HashMap<String, Value>) -> String {
    let name: String = payload
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '_' | '-'))
        .collect();
    if name.is_empty() {
        return String::new();
    }
    let tag = format!("{}-{}", kind, name);
    if !sets.contains_key(&tag) {
        let repo = if kind == "geoip" {
            "sing-geoip"
        } else {
            "sing-geosite"
        };
        sets.insert(
            tag.clone(),
            json!({
                "type": "remote", "tag": tag, "format": "binary",
                "url": format!("https://raw.githubusercontent.com/SagerNet/{}/rule-set/{}.srs", repo, tag),
                "download_detour": "DIRECT",
            }),
        );
    }
    tag
}

fn convert_rules(
    clash: &Value,
    valid: &HashSet<String>,
    final_tag: &str,
    warnings: &mut Vec<String>,
    sets: &mut HashMap<String, Value>,
) -> Vec<Value> {
    let raw = clash
        .get("rules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    let mut skipped = 0;
    for line in raw {
        let Some(line) = line.as_str() else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let mut parts: Vec<String> = line.split(',').map(|s| s.trim().to_string()).collect();
        if parts.len() > 2 && parts.last().map(|s| s.eq_ignore_ascii_case("no-resolve")).unwrap_or(false) {
            parts.pop();
        }
        if parts.len() < 2 {
            skipped += 1;
            continue;
        }
        let ty = parts[0].to_uppercase();
        let payload = if parts.len() >= 3 {
            parts[1..parts.len() - 1].join(",")
        } else {
            parts[1].clone()
        };
        let action = if parts.len() >= 3 {
            parts.last().cloned().unwrap_or_default()
        } else {
            "MATCH".to_string()
        };
        if payload.is_empty() {
            skipped += 1;
            continue;
        }
        let mut rule = Map::new();
        if matches!(action.as_str(), "REJECT" | "REJECT-DROP") {
            rule.insert("action".into(), json!("reject"));
        } else if action.is_empty() || action == "MATCH" || action == "PROXY" {
            rule.insert("outbound".into(), json!(final_tag));
        } else if action == "DIRECT" || action == "PASS" || action == "COMPATIBLE" {
            rule.insert("outbound".into(), json!("DIRECT"));
        } else if valid.contains(&action) {
            rule.insert("outbound".into(), json!(action));
        } else {
            rule.insert("outbound".into(), json!(final_tag));
        }
        let mut ok = true;
        match ty.as_str() {
            "DOMAIN" => rule.insert("domain".into(), json!([payload])),
            "DOMAIN-SUFFIX" => rule.insert("domain_suffix".into(), json!([payload])),
            "DOMAIN-KEYWORD" => rule.insert("domain_keyword".into(), json!([payload])),
            "DOMAIN-REGEX" => rule.insert("domain_regex".into(), json!([payload])),
            "IP-CIDR" | "IP-CIDR6" => rule.insert("ip_cidr".into(), json!([payload])),
            "SRC-IP-CIDR" => rule.insert("source_ip_cidr".into(), json!([payload])),
            "DST-PORT" | "DST-PORTS" => {
                let (ports, ranges) = parse_ports(&payload);
                if !ports.is_empty() {
                    rule.insert("port".into(), json!(ports));
                }
                if !ranges.is_empty() {
                    rule.insert("port_range".into(), json!(ranges));
                }
                if ports.is_empty() && ranges.is_empty() {
                    ok = false;
                }
                None
            }
            "SRC-PORT" | "SRC-PORTS" => {
                let (ports, ranges) = parse_ports(&payload);
                if !ports.is_empty() {
                    rule.insert("source_port".into(), json!(ports));
                }
                if !ranges.is_empty() {
                    rule.insert("source_port_range".into(), json!(ranges));
                }
                if ports.is_empty() && ranges.is_empty() {
                    ok = false;
                }
                None
            }
            "GEOIP" => {
                let tag = geo_rule_set("geoip", &payload, sets);
                if tag.is_empty() {
                    ok = false;
                } else {
                    rule.insert("rule_set".into(), json!([tag]));
                }
                None
            }
            "GEOSITE" => {
                let tag = geo_rule_set("geosite", &payload, sets);
                if tag.is_empty() {
                    ok = false;
                } else {
                    rule.insert("rule_set".into(), json!([tag]));
                }
                None
            }
            "PROCESS-NAME" => rule.insert("process_name".into(), json!([payload])),
            "PROCESS-PATH" => rule.insert("process_path".into(), json!([payload])),
            "MATCH" => continue,
            _ => {
                skipped += 1;
                ok = false;
                None
            }
        };
        if ok {
            out.push(Value::Object(rule));
        }
    }
    if skipped > 0 {
        warnings.push(format!("{} 条规则暂不支持（RULE-SET/复合规则等），已跳过", skipped));
    }
    out
}

pub struct ConvertResult {
    pub config: Value,
    pub warnings: Vec<String>,
    pub stats: Value,
}

pub fn convert_clash_to_singbox(clash: &Value, opts: &Value) -> ConvertResult {
    let mut warnings = Vec::new();
    let c = if clash.is_object() { clash.clone() } else { json!({}) };
    let mixed_port = num_u(opts.get("mixedPort"), 17897);
    let ctrl_host = str_of(opts.get("controllerHost"), "127.0.0.1");
    let ctrl_port = num_u(opts.get("controllerPort"), 19097);
    let secret = str_of(opts.get("secret"), "");
    let allow_lan = opts.get("allowLan").and_then(|v| v.as_bool()).unwrap_or(false);
    let log_level = match str_of(opts.get("logLevel"), "info").as_str() {
        "silent" => "panic",
        "error" => "error",
        "warning" => "warn",
        "debug" => "debug",
        _ => "info",
    };

    let raw_proxies = c
        .get("proxies")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut outbounds: Vec<Value> = Vec::new();
    let mut proxy_tags: HashSet<String> = HashSet::new();
    let mut skipped_nodes = 0;
    for p in &raw_proxies {
        match convert_proxy(p, &mut warnings) {
            Some(o) => {
                let tag = o.get("tag").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !proxy_tags.contains(&tag) {
                    proxy_tags.insert(tag);
                    outbounds.push(o);
                }
            }
            None => skipped_nodes += 1,
        }
    }
    let mut valid: HashSet<String> = proxy_tags.clone();
    for t in ["DIRECT", "REJECT", "REJECT-DROP"] {
        valid.insert(t.to_string());
    }
    let groups = emit_groups(&c, &valid, &mut warnings);
    for g in &groups {
        if let Some(tag) = g.get("tag").and_then(|v| v.as_str()) {
            valid.insert(tag.to_string());
        }
        outbounds.push(g.clone());
    }
    outbounds.push(json!({ "type": "direct", "tag": "DIRECT" }));
    outbounds.push(json!({ "type": "block", "tag": "REJECT" }));
    outbounds.push(json!({ "type": "block", "tag": "REJECT-DROP" }));

    let final_tag = if valid.contains("PROXY") {
        "PROXY".to_string()
    } else if let Some(first) = groups.first().and_then(|g| g.get("tag")).and_then(|v| v.as_str()) {
        first.to_string()
    } else if let Some(first) = proxy_tags.iter().next() {
        first.clone()
    } else {
        "DIRECT".to_string()
    };

    let mut rule_sets: HashMap<String, Value> = HashMap::new();
    let route_rules = convert_rules(&c, &valid, &final_tag, &mut warnings, &mut rule_sets);

    let first_proxy = proxy_tags.iter().next().cloned().unwrap_or_default();
    let mut dns_servers = Vec::new();
    if !first_proxy.is_empty() {
        dns_servers.push(json!({
            "tag": "dns-proxy", "type": "tls", "server": "8.8.8.8", "detour": first_proxy,
        }));
    }
    dns_servers.push(json!({ "tag": "dns-direct", "type": "udp", "server": "223.5.5.5" }));
    let mut dns_rules = vec![json!({ "clash_mode": "Direct", "server": "dns-direct" })];
    if !first_proxy.is_empty() {
        dns_rules.push(json!({ "clash_mode": "Global", "server": "dns-proxy" }));
    }

    let mut route = Map::new();
    if !rule_sets.is_empty() {
        let sets: Vec<Value> = rule_sets.into_values().collect();
        route.insert("rule_set".into(), Value::Array(sets));
    }
    route.insert("rules".into(), Value::Array(route_rules.clone()));
    route.insert("final".into(), json!(final_tag));
    route.insert("default_domain_resolver".into(), json!("dns-direct"));

    let config = json!({
        "log": { "level": log_level, "timestamp": true },
        "dns": { "servers": dns_servers, "rules": dns_rules, "final": "dns-direct" },
        "inbounds": [{
            "type": "mixed", "tag": "mixed-in",
            "listen": if allow_lan { "0.0.0.0" } else { "127.0.0.1" },
            "listen_port": mixed_port,
        }],
        "outbounds": outbounds,
        "route": Value::Object(route),
        "experimental": {
            "clash_api": {
                "external_controller": format!("{}:{}", ctrl_host, ctrl_port),
                "secret": if secret.is_empty() { Value::Null } else { json!(secret) },
                "default_mode": "Rule",
            }
        },
    });

    ConvertResult {
        config,
        warnings,
        stats: json!({
            "nodes": proxy_tags.len(),
            "skippedNodes": skipped_nodes,
            "groups": groups.len(),
            "rules": route_rules.len(),
            "final": final_tag,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_basic_yaml() {
        let clash = json!({
            "proxies": [
                {"name": "n1", "type": "ss", "server": "1.2.3.4", "port": 8388, "cipher": "aes-128-gcm", "password": "p"}
            ],
            "proxy-groups": [{"name": "PROXY", "type": "select", "proxies": ["n1", "DIRECT"]}],
            "rules": ["DOMAIN-SUFFIX,example.com,PROXY", "GEOIP,CN,DIRECT", "MATCH,PROXY"],
        });
        let r = convert_clash_to_singbox(&clash, &json!({"mixedPort": 7890}));
        assert_eq!(r.stats["nodes"], 1);
        assert_eq!(r.stats["groups"], 1);
        assert_eq!(r.config["inbounds"][0]["listen_port"], 7890);
        assert!(r.warnings.iter().all(|w| !w.contains("规则暂不支持")));
    }

    #[test]
    fn strips_no_resolve() {
        let clash = json!({"rules": ["IP-CIDR,1.1.1.0/24,no-resolve", "MATCH,DIRECT"]});
        let r = convert_clash_to_singbox(&clash, &json!({}));
        assert_eq!(r.config["route"]["rules"][0]["ip_cidr"][0], "1.1.1.0/24");
        assert_eq!(r.config["route"]["rules"][0]["outbound"], "DIRECT");
    }
}
