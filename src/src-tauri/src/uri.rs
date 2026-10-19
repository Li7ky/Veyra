//! 单节点 URI → Clash proxy 对象（对齐 Electron uri-import.cjs）。
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::util;

fn parse_query(q: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for part in q.trim_start_matches('?').split('&') {
        if part.is_empty() {
            continue;
        }
        let mut it = part.splitn(2, '=');
        let k = util::percent_decode(it.next().unwrap_or(""));
        let v = util::percent_decode(it.next().unwrap_or(""));
        out.insert(k, Value::String(v));
    }
    out
}

fn q<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    m.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

fn safe_name(n: &str, fallback: &str) -> String {
    let s = util::sanitize_name(n);
    if s.is_empty() || s == "profile" {
        fallback.to_string()
    } else {
        s
    }
}

fn host_port(hostport: &str) -> (String, Option<u16>) {
    // [2001:db8::1]:8388 或 host:port
    if let Some(rest) = hostport.strip_prefix('[') {
        if let Some((host, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
            return (host.to_string(), port);
        }
    }
    match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()),
        None => (hostport.to_string(), None),
    }
}

fn parse_ss(uri: &str) -> Result<Value, String> {
    let mut rest = uri[5..].to_string();
    let mut name = "ss-node".to_string();
    if let Some(hash) = rest.find('#') {
        let decoded = util::percent_decode(&rest[hash + 1..]);
        if !decoded.is_empty() {
            name = decoded;
        }
        rest = rest[..hash].to_string();
    }

    let mut userinfo;
    let hostport;
    let mut from_base64 = false;
    if rest.contains('@') {
        if !rest.contains(':') {
            if let Some(bytes) = util::b64_decode_flexible(&rest) {
                rest = String::from_utf8_lossy(&bytes).to_string();
                from_base64 = true;
            }
        }
        let at = rest.rfind('@').ok_or("ss 节点解析失败")?;
        userinfo = rest[..at].to_string();
        hostport = rest[at + 1..].to_string();
        if !userinfo.contains(':') {
            if let Some(bytes) = util::b64_decode_flexible(&userinfo) {
                userinfo = String::from_utf8_lossy(&bytes).to_string();
                from_base64 = true;
            }
        }
    } else {
        from_base64 = true;
        let decoded = util::b64_decode_flexible(&rest).ok_or("ss 节点解析失败")?;
        let decoded = String::from_utf8_lossy(&decoded).to_string();
        let at = decoded.rfind('@').ok_or("ss 节点解析失败")?;
        userinfo = decoded[..at].to_string();
        hostport = decoded[at + 1..].to_string();
    }
    let (method, mut password) = match userinfo.split_once(':') {
        Some((m, p)) => (m.to_string(), p.to_string()),
        None => return Err("ss 节点解析失败：缺少加密方式或密码".into()),
    };
    if !from_base64 {
        password = util::percent_decode(&password);
    }
    let (server, port) = host_port(&hostport);
    if server.is_empty() || port.is_none() {
        return Err(format!("ss 节点解析失败：无法识别 server/port（{}）", hostport));
    }
    Ok(json!({
        "name": safe_name(&name, "ss"),
        "type": "ss",
        "server": server,
        "port": port.unwrap_or(443),
        "cipher": method,
        "password": password,
        "udp": true,
    }))
}

fn parse_vmess(uri: &str) -> Result<Value, String> {
    let decoded = util::b64_decode_flexible(&uri[8..]).ok_or("vmess 节点 Base64 解析失败")?;
    let j: Value =
        serde_json::from_slice(&decoded).map_err(|e| format!("vmess 节点 JSON 解析失败：{}", e))?;
    let net = j
        .get("net")
        .and_then(|v| v.as_str())
        .unwrap_or("tcp")
        .to_string();
    let mut proxy = json!({
        "name": safe_name(
            j.get("ps").or_else(|| j.get("remark")).or_else(|| j.get("name"))
                .and_then(|v| v.as_str()).unwrap_or(""),
            "vmess"),
        "type": "vmess",
        "server": j.get("add").or_else(|| j.get("server")).and_then(|v| v.as_str()).unwrap_or(""),
        "port": j.get("port").and_then(|v| {
            v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
        }).unwrap_or(443),
        "uuid": j.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "alterId": j.get("aid").or_else(|| j.get("alterId")).and_then(|v| v.as_u64()).unwrap_or(0),
        "cipher": j.get("scy").and_then(|v| v.as_str()).unwrap_or("auto"),
        "udp": true,
        "tls": matches!(j.get("tls").and_then(|v| v.as_str()), Some("tls")),
        "network": net,
    });
    if let Some(sni) = j.get("sni").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        proxy["servername"] = json!(sni);
    } else if let Some(host) = j.get("host").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        proxy["servername"] = json!(host);
    }
    if let Some(obj) = proxy.as_object_mut() {
        if obj.get("server").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
            obj.remove("server");
        }
    }
    if net == "ws" {
        let mut ws = Map::new();
        ws.insert(
            "path".into(),
            json!(j.get("path").and_then(|v| v.as_str()).unwrap_or("/")),
        );
        if let Some(host) = j.get("host").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            ws.insert("headers".into(), json!({ "Host": host }));
        }
        proxy["ws-opts"] = Value::Object(ws);
    }
    if net == "grpc" {
        proxy["grpc-opts"] = json!({
            "grpc-service-name": j.get("path").and_then(|v| v.as_str()).unwrap_or("")
        });
    }
    Ok(proxy)
}

fn parse_vless(uri: &str) -> Result<Value, String> {
    let u = url::Url::parse(uri).map_err(|e| format!("vless 节点解析失败：{}", e))?;
    let query = parse_query(u.query().unwrap_or(""));
    let name = util::percent_decode(u.fragment().unwrap_or(""));
    let security = q(&query, "security").unwrap_or("");
    let typ = q(&query, "type").unwrap_or("tcp").to_string();
    let mut proxy = json!({
        "name": safe_name(&name, "vless"),
        "type": "vless",
        "server": u.host_str().unwrap_or(""),
        "port": u.port().unwrap_or(443),
        "uuid": util::percent_decode(u.username()),
        "udp": true,
        "tls": security == "tls" || security == "reality",
        "network": typ,
    });
    if let Some(sni) = q(&query, "sni") {
        proxy["servername"] = json!(sni);
    }
    if let Some(flow) = q(&query, "flow") {
        proxy["flow"] = json!(flow);
    }
    if let Some(fp) = q(&query, "fp") {
        proxy["client-fingerprint"] = json!(fp);
    }
    if security == "reality" {
        proxy["reality-opts"] = json!({
            "public-key": q(&query, "pbk").unwrap_or(""),
            "short-id": q(&query, "sid").unwrap_or(""),
        });
    }
    if typ == "ws" {
        let mut ws = Map::new();
        ws.insert("path".into(), json!(q(&query, "path").unwrap_or("/")));
        if let Some(host) = q(&query, "host") {
            ws.insert("headers".into(), json!({ "Host": host }));
        }
        proxy["ws-opts"] = Value::Object(ws);
    }
    if typ == "grpc" {
        proxy["grpc-opts"] = json!({
            "grpc-service-name": q(&query, "serviceName").or_else(|| q(&query, "path")).unwrap_or("")
        });
    }
    Ok(proxy)
}

fn parse_trojan(uri: &str) -> Result<Value, String> {
    let u = url::Url::parse(uri).map_err(|e| format!("trojan 节点解析失败：{}", e))?;
    let query = parse_query(u.query().unwrap_or(""));
    let name = util::percent_decode(u.fragment().unwrap_or(""));
    let typ = q(&query, "type").unwrap_or("tcp").to_string();
    let mut proxy = json!({
        "name": safe_name(&name, "trojan"),
        "type": "trojan",
        "server": u.host_str().unwrap_or(""),
        "port": u.port().unwrap_or(443),
        "password": util::percent_decode(u.username()),
        "udp": true,
        "sni": q(&query, "sni").unwrap_or_else(|| u.host_str().unwrap_or("")),
        "network": typ,
    });
    if typ == "ws" {
        let mut ws = Map::new();
        ws.insert("path".into(), json!(q(&query, "path").unwrap_or("/")));
        if let Some(host) = q(&query, "host") {
            ws.insert("headers".into(), json!({ "Host": host }));
        }
        proxy["ws-opts"] = Value::Object(ws);
    }
    Ok(proxy)
}

fn parse_hysteria2(uri: &str) -> Result<Value, String> {
    let normalized = regex::Regex::new("(?i)^hy2:").unwrap().replace(uri, "hysteria2:");
    let u = url::Url::parse(&normalized)
        .map_err(|e| format!("hysteria2 节点解析失败：{}", e))?;
    let query = parse_query(u.query().unwrap_or(""));
    let name = util::percent_decode(u.fragment().unwrap_or(""));
    let insecure = matches!(q(&query, "insecure"), Some("1") | Some("true"));
    Ok(json!({
        "name": safe_name(&name, "hysteria2"),
        "type": "hysteria2",
        "server": u.host_str().unwrap_or(""),
        "port": u.port().unwrap_or(443),
        "password": util::percent_decode(u.username()),
        "sni": q(&query, "sni"),
        "skip-cert-verify": insecure,
    }))
}

fn parse_tuic(uri: &str) -> Result<Value, String> {
    let u = url::Url::parse(uri).map_err(|e| format!("tuic 节点解析失败：{}", e))?;
    let query = parse_query(u.query().unwrap_or(""));
    let name = util::percent_decode(u.fragment().unwrap_or(""));
    let password = u
        .password()
        .map(util::percent_decode)
        .filter(|s| !s.is_empty())
        .or_else(|| q(&query, "password").map(|s| s.to_string()))
        .unwrap_or_default();
    Ok(json!({
        "name": safe_name(&name, "tuic"),
        "type": "tuic",
        "server": u.host_str().unwrap_or(""),
        "port": u.port().unwrap_or(443),
        "uuid": util::percent_decode(u.username()),
        "password": password,
        "sni": q(&query, "sni"),
        "congestion-controller": q(&query, "congestion_control").unwrap_or("bbr"),
        "udp-relay-mode": q(&query, "udp_relay_mode").unwrap_or("native"),
    }))
}

fn drop_nulls(v: &mut Value) {
    if let Some(obj) = v.as_object_mut() {
        obj.retain(|_, val| !val.is_null());
    }
}

pub fn parse_node_uri(uri: &str) -> Result<Value, String> {
    let u = uri.trim();
    if u.is_empty() {
        return Err("空 URI".into());
    }
    let lower = u.to_lowercase();
    let mut proxy = if lower.starts_with("ss://") {
        parse_ss(u)?
    } else if lower.starts_with("vmess://") {
        parse_vmess(u)?
    } else if lower.starts_with("vless://") {
        parse_vless(u)?
    } else if lower.starts_with("trojan://") {
        parse_trojan(u)?
    } else if lower.starts_with("hysteria2://") || lower.starts_with("hy2://") {
        parse_hysteria2(u)?
    } else if lower.starts_with("tuic://") {
        parse_tuic(u)?
    } else {
        return Err("不支持的节点 URI 协议".into());
    };
    drop_nulls(&mut proxy);
    let server = proxy.get("server").and_then(|v| v.as_str()).unwrap_or("");
    if server.is_empty() {
        return Err("节点解析失败：server 缺失".into());
    }
    let port = proxy.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
    if port == 0 || port > 65535 {
        return Err("节点解析失败：port 非法".into());
    }
    if proxy.get("type").and_then(|v| v.as_str()) == Some("vmess")
        && proxy.get("uuid").and_then(|v| v.as_str()).unwrap_or("").is_empty()
    {
        return Err("节点解析失败：vmess 缺少 uuid".into());
    }
    Ok(proxy)
}

pub fn proxy_to_yaml_doc(proxy: &Value) -> Result<Value, String> {
    let name = proxy
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("node");
    let doc = json!({
        "proxies": [proxy.clone()],
        "proxy-groups": [{
            "name": "PROXY",
            "type": "select",
            "proxies": [name, "DIRECT"],
        }],
        "rules": ["MATCH,PROXY"],
    });
    let content = serde_yaml::to_string(&doc).map_err(|e| e.to_string())?;
    Ok(json!({
        "name": name,
        "type": proxy.get("type").cloned().unwrap_or(Value::Null),
        "content": content,
        "proxy": proxy,
    }))
}

const INFO_NAME_RE: &str = "剩余流量|已用流量|套餐到期|距离.*重置|到期时间|流量.*GB|有效期";

fn is_info_node(name: &str) -> bool {
    regex::Regex::new(INFO_NAME_RE)
        .map(|re| re.is_match(name))
        .unwrap_or(false)
}

pub fn uris_to_yaml_doc(uris: &[String]) -> Result<String, String> {
    let mut proxies: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for u in uris {
        let Ok(mut p) = parse_node_uri(u) else {
            continue;
        };
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() || is_info_node(name) {
            continue;
        }
        let base = name.to_string();
        let mut unique = base.clone();
        let mut i = 2;
        while seen.contains(&unique) {
            unique = format!("{} {}", base, i);
            i += 1;
        }
        seen.insert(unique.clone());
        p["name"] = json!(unique);
        proxies.push(p);
    }
    if proxies.is_empty() {
        return Err("节点列表为空或全部无法解析".into());
    }
    let names: Vec<String> = proxies
        .iter()
        .map(|p| {
            p.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();
    let mut group_names = names.clone();
    group_names.push("DIRECT".into());
    let doc = json!({
        "proxies": proxies,
        "proxy-groups": [
            { "name": "PROXY", "type": "select", "proxies": group_names },
            {
                "name": "自动选择",
                "type": "url-test",
                "proxies": names,
                "url": "https://www.gstatic.com/generate_204",
                "interval": 300,
            }
        ],
        "rules": ["MATCH,PROXY"],
    });
    serde_yaml::to_string(&doc).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vless() {
        let p = parse_node_uri(
            "vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&type=ws&path=%2Fws&sni=example.com#Node%201",
        )
        .unwrap();
        assert_eq!(p["server"], "example.com");
        assert_eq!(p["port"], 443);
        assert_eq!(p["name"], "Node 1");
        assert_eq!(p["tls"], true);
    }

    #[test]
    fn parses_ss_plain() {
        let p = parse_node_uri("ss://aes-128-gcm:p%40ss@1.2.3.4:8388#ss").unwrap();
        assert_eq!(p["password"], "p@ss");
        assert_eq!(p["cipher"], "aes-128-gcm");
    }

    #[test]
    fn parses_ss_base64() {
        let raw = util::b64_encode(b"aes-256-gcm:pw@host.example:443");
        let p = parse_node_uri(&format!("ss://{}#b64", raw)).unwrap();
        assert_eq!(p["server"], "host.example");
        assert_eq!(p["port"], 443);
        assert_eq!(p["password"], "pw");
    }

    #[test]
    fn rejects_unknown() {
        assert!(parse_node_uri("http://example.com").is_err());
    }
}
