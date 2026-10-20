//! 出口 IP 探测（对齐 Electron verge-ext.fetchExitIp）。
use serde_json::{json, Map, Value};
use std::time::Duration;

struct Endpoint {
    url: &'static str,
    kind: EndpointKind,
}

enum EndpointKind {
    Json,
    CloudflareTrace,
}

const ENDPOINTS: &[Endpoint] = &[
    Endpoint { url: "https://api.ip.sb/geoip", kind: EndpointKind::Json },
    Endpoint { url: "https://ipwho.is/", kind: EndpointKind::Json },
    Endpoint { url: "https://ifconfig.co/json", kind: EndpointKind::Json },
    Endpoint { url: "https://www.cloudflare.com/cdn-cgi/trace", kind: EndpointKind::CloudflareTrace },
    Endpoint { url: "http://ip-api.com/json?fields=query,country,countryCode,city,regionName,isp,org,as,timezone,lat,lon", kind: EndpointKind::Json },
    Endpoint { url: "https://ipinfo.io/json", kind: EndpointKind::Json },
    Endpoint { url: "http://httpbin.org/ip", kind: EndpointKind::Json },
];

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|x| !x.is_empty())
        .map(|x| x.to_string())
}

fn n(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn parse_json(url: &str, j: &Value) -> Option<Value> {
    let mut out = Map::new();
    let ip = s(j, "ip")
        .or_else(|| s(j, "query"))
        .or_else(|| s(j, "origin").map(|o| o.split(',').next().unwrap_or("").trim().to_string()))?;
    if ip.is_empty() {
        return None;
    }
    out.insert("ip".into(), json!(ip));
    // 按端点对齐字段
    if url.contains("ip.sb") {
        for (k, src) in [
            ("country", "country"),
            ("countryCode", "country_code"),
            ("city", "city"),
            ("region", "region"),
            ("isp", "isp"),
            ("org", "organization"),
            ("timezone", "timezone"),
        ] {
            if let Some(v) = s(j, src) {
                out.insert(k.into(), json!(v));
            }
        }
        if let Some(asn) = j.get("asn").and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_u64().map(|n| format!("AS{}", n)))) {
            out.insert("as".into(), json!(if asn.starts_with("AS") { asn } else { format!("AS{}", asn) }));
        }
        if let Some(v) = n(j, "latitude") {
            out.insert("lat".into(), json!(v));
        }
        if let Some(v) = n(j, "longitude") {
            out.insert("lon".into(), json!(v));
        }
    } else if url.contains("ipwho.is") {
        if j.get("success").and_then(|v| v.as_bool()) == Some(false) {
            return None;
        }
        for (k, src) in [
            ("country", "country"),
            ("countryCode", "country_code"),
            ("city", "city"),
            ("region", "region"),
        ] {
            if let Some(v) = s(j, src) {
                out.insert(k.into(), json!(v));
            }
        }
        if let Some(c) = j.get("connection") {
            if let Some(v) = s(c, "isp") {
                out.insert("isp".into(), json!(v));
            }
            if let Some(v) = s(c, "org") {
                out.insert("org".into(), json!(v));
            }
            if let Some(v) = c.get("asn").and_then(|x| x.as_u64()) {
                out.insert("as".into(), json!(format!("AS{}", v)));
            }
        }
        if let Some(v) = j.get("timezone").and_then(|t| t.get("id")).and_then(|v| v.as_str()) {
            out.insert("timezone".into(), json!(v));
        }
        if let Some(v) = n(j, "latitude") {
            out.insert("lat".into(), json!(v));
        }
        if let Some(v) = n(j, "longitude") {
            out.insert("lon".into(), json!(v));
        }
    } else if url.contains("ifconfig.co") {
        for (k, src) in [
            ("country", "country"),
            ("countryCode", "country_iso"),
            ("city", "city"),
            ("region", "region_name"),
            ("isp", "asn_org"),
            ("org", "asn_org"),
            ("timezone", "time_zone"),
        ] {
            if let Some(v) = s(j, src) {
                out.insert(k.into(), json!(v));
            }
        }
        if let Some(v) = j.get("asn").and_then(|x| x.as_u64()) {
            out.insert("as".into(), json!(format!("AS{}", v)));
        }
        if let Some(v) = n(j, "latitude") {
            out.insert("lat".into(), json!(v));
        }
        if let Some(v) = n(j, "longitude") {
            out.insert("lon".into(), json!(v));
        }
    } else if url.contains("ip-api.com") {
        for (k, src) in [
            ("country", "country"),
            ("countryCode", "countryCode"),
            ("city", "city"),
            ("region", "regionName"),
            ("isp", "isp"),
            ("org", "org"),
            ("as", "as"),
            ("timezone", "timezone"),
        ] {
            if let Some(v) = s(j, src) {
                out.insert(k.into(), json!(v));
            }
        }
        if let Some(v) = n(j, "lat") {
            out.insert("lat".into(), json!(v));
        }
        if let Some(v) = n(j, "lon") {
            out.insert("lon".into(), json!(v));
        }
    } else if url.contains("ipinfo.io") {
        for (k, src) in [
            ("country", "country"),
            ("countryCode", "country"),
            ("city", "city"),
            ("region", "region"),
            ("isp", "org"),
            ("org", "org"),
            ("timezone", "timezone"),
        ] {
            if let Some(v) = s(j, src) {
                out.insert(k.into(), json!(v));
            }
        }
        if let Some(loc) = s(j, "loc") {
            let mut parts = loc.split(',');
            if let Some(lat) = parts.next().and_then(|x| x.parse::<f64>().ok()) {
                out.insert("lat".into(), json!(lat));
            }
            if let Some(lon) = parts.next().and_then(|x| x.parse::<f64>().ok()) {
                out.insert("lon".into(), json!(lon));
            }
        }
    }
    Some(Value::Object(out))
}

fn parse_trace(text: &str) -> Option<Value> {
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let ip = map.get("ip")?.clone();
    let mut out = Map::new();
    out.insert("ip".into(), json!(ip));
    if let Some(loc) = map.get("loc") {
        out.insert("countryCode".into(), json!(loc));
    }
    Some(Value::Object(out))
}

pub async fn fetch_exit_ip(mixed_port: u16, via_proxy: bool) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    for ep in ENDPOINTS {
        let remain = deadline.saturating_duration_since(std::time::Instant::now());
        if remain < Duration::from_millis(1200) {
            break;
        }
        let timeout = remain.min(Duration::from_secs(4));
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent("Veyra/1.0")
            .danger_accept_invalid_certs(true);
        builder = if via_proxy && mixed_port > 0 {
            match reqwest::Proxy::all(format!("http://127.0.0.1:{}", mixed_port)) {
                Ok(p) => builder.proxy(p),
                Err(_) => builder.no_proxy(),
            }
        } else {
            builder.no_proxy()
        };
        let Ok(client) = builder.build() else { continue };
        let Ok(resp) = client.get(ep.url).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let text = resp.text().await.unwrap_or_default();
        let info = match ep.kind {
            EndpointKind::CloudflareTrace => parse_trace(&text),
            EndpointKind::Json => match serde_json::from_str::<Value>(&text) {
                Ok(j) => parse_json(ep.url, &j),
                Err(_) => {
                    let re = regex::Regex::new(r"\d{1,3}(?:\.\d{1,3}){3}").unwrap();
                    re.find(&text).map(|m| json!({ "ip": m.as_str() }))
                }
            },
        };
        if let Some(info) = info {
            if info.get("ip").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                return info;
            }
        }
    }
    json!({ "ip": Value::Null })
}
