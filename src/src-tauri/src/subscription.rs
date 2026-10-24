//! 订阅下载、解析与元数据（对齐 Electron main.cjs / subscription-info.cjs）。
use base64::Engine;
use serde_json::{json, Map, Value};
use std::time::Duration;

use crate::state::Paths;
use crate::uri;
use crate::util;

pub const METADATA_REFRESH_COOLDOWN_MS: i64 = 24 * 60 * 60 * 1000;
pub const SUB_UA: &str = "ClashMetaForAndroid/2.11.0";

/// 订阅正文归一化：Clash YAML / Base64 YAML / 纯节点 URI 列表。
pub fn normalize_subscription_body(bytes: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(bytes).to_string();
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if util::looks_like_clash_yaml(trimmed) {
        return Ok(trimmed.to_string());
    }
    // 整段 Base64 的 Clash YAML 或节点列表
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if let Some(decoded) = util::b64_decode_flexible(&compact) {
        let decoded = String::from_utf8_lossy(&decoded).to_string();
        if util::looks_like_clash_yaml(&decoded) {
            return Ok(decoded);
        }
        let lines: Vec<String> = decoded
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| {
                let lower = l.to_lowercase();
                lower.starts_with("ss://")
                    || lower.starts_with("ssr://")
                    || lower.starts_with("vmess://")
                    || lower.starts_with("vless://")
                    || lower.starts_with("trojan://")
                    || lower.starts_with("hysteria2://")
                    || lower.starts_with("hysteria://")
                    || lower.starts_with("hy2://")
                    || lower.starts_with("tuic://")
                    || lower.starts_with("wireguard://")
            })
            .collect();
        if !lines.is_empty() {
            return uri::uris_to_yaml_doc(&lines);
        }
    }
    if trimmed.contains("proxies:") || trimmed.contains("proxy-groups:") {
        return Ok(trimmed.to_string());
    }
    Err("无法识别订阅格式（需要 Clash/Mihomo YAML 或 Base64 YAML）".into())
}

/// 机场在响应头里给的可读名字。
pub fn name_from_headers(headers: &Value) -> String {
    let Some(map) = headers.as_object() else {
        return String::new();
    };
    for (k, raw) in map {
        let key = k.to_lowercase();
        let val = raw.as_str().unwrap_or("").trim();
        if val.is_empty() {
            continue;
        }
        if key == "content-disposition" {
            let star = regex::Regex::new(r#"(?i)filename\*\s*=\s*UTF-8''([^;]+)"#).unwrap();
            if let Some(c) = star.captures(val) {
                let decoded = util::percent_decode(c.get(1).map(|m| m.as_str()).unwrap_or(""));
                if !decoded.is_empty() {
                    return decoded;
                }
            }
            let plain = regex::Regex::new(r#"(?i)filename\s*=\s*"?([^";]+)"?"#).unwrap();
            if let Some(c) = plain.captures(val) {
                let name = c.get(1).map(|m| m.as_str().trim()).unwrap_or("");
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
        if key == "profile-title" {
            if let Some(b64) = val
                .strip_prefix("base64:")
                .or_else(|| val.strip_prefix("base64："))
            {
                if let Some(bytes) = util::b64_decode_flexible(b64.trim()) {
                    let decoded = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !decoded.is_empty() {
                        return decoded;
                    }
                }
                continue;
            }
            return val.to_string();
        }
    }
    String::new()
}

pub fn header_value(headers: &Value, name: &str) -> Option<String> {
    headers
        .as_object()
        .and_then(|m| {
            m.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        })
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}

/// Subscription-Userinfo: upload=..; download=..; total=..; expire=..
pub fn parse_userinfo(headers: &Value) -> Option<Value> {
    let Some(map) = headers.as_object() else {
        return None;
    };
    let raw = map
        .iter()
        .find(|(k, _)| k.to_lowercase().ends_with("subscription-userinfo"))
        .map(|(_, v)| v.as_str().unwrap_or("").to_string())?;
    if raw.is_empty() {
        return None;
    }
    let mut out = Map::new();
    for part in raw.split(';') {
        if let Some((k, v)) = part.split_once('=') {
            let n: i64 = v.trim().parse().unwrap_or(0);
            out.insert(k.trim().to_lowercase(), json!(n));
        }
    }
    let total = out.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    if total <= 0 {
        return None;
    }
    Some(json!({
        "upload": out.get("upload").and_then(|v| v.as_i64()).unwrap_or(0),
        "download": out.get("download").and_then(|v| v.as_i64()).unwrap_or(0),
        "total": total,
        "expire": out.get("expire").and_then(|v| v.as_i64()).unwrap_or(0),
    }))
}

pub fn update_interval_hours(headers: &Value) -> i64 {
    header_value(headers, "profile-update-interval")
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

/// 订阅响应体大小上限：防止被劫持的端点用超大响应灌爆内存。
const MAX_SUB_BYTES: usize = 64 * 1024 * 1024;

fn headers_to_json(headers: &reqwest::header::HeaderMap) -> Value {
    let mut out = Map::new();
    for (k, v) in headers.iter() {
        // 非 ASCII 头值（机场常见的裸 UTF-8 Content-Disposition 文件名）用 to_str 会
        // 变成空串；改按字节做 UTF-8 宽松解码。同名头保留先到的值。
        let val = String::from_utf8_lossy(v.as_bytes()).to_string();
        out.entry(k.as_str().to_string())
            .or_insert(Value::String(val));
    }
    Value::Object(out)
}

async fn fetch_once(
    url: &str,
    proxy: Option<u16>,
    timeout_sec: u64,
) -> Result<(Vec<u8>, Value), String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_sec.max(5)))
        .user_agent(SUB_UA)
        .redirect(reqwest::redirect::Policy::limited(10));
    if let Some(port) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{}", port)).map_err(|e| e.to_string())?);
    } else {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_SUB_BYTES {
            return Err(format!("订阅体积超过上限（{} MB）", MAX_SUB_BYTES / 1024 / 1024));
        }
    }
    let headers = headers_to_json(resp.headers());
    // 分块读取并限制总量：Content-Length 缺失（chunked）时也不能无界读入内存。
    let mut bytes: Vec<u8> = Vec::new();
    {
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            if bytes.len() + chunk.len() > MAX_SUB_BYTES {
                return Err(format!("订阅体积超过上限（{} MB）", MAX_SUB_BYTES / 1024 / 1024));
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    if !status.is_success() {
        return Err(format!("HTTP {}（订阅拉取失败）", status.as_u16()));
    }
    if bytes.is_empty() {
        return Err("订阅内容为空".into());
    }
    Ok((bytes, headers))
}

/// 下载订阅：默认先走本地混合端口，失败回退直连（与 Electron 版一致）。
pub async fn fetch_subscription(
    url: &str,
    mixed_port: u16,
    via_proxy: bool,
    timeout_sec: u64,
) -> Result<(Vec<u8>, Value), String> {
    let proxies = if via_proxy {
        vec![Some(mixed_port), None]
    } else {
        vec![None, Some(mixed_port)]
    };
    let mut last_err = String::from("订阅下载失败");
    for proxy in proxies {
        match fetch_once(url, proxy, timeout_sec).await {
            Ok(v) => return Ok(v),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

pub fn meta_path(paths: &Paths) -> std::path::PathBuf {
    paths.subscriptions.clone()
}

pub fn read_meta(paths: &Paths) -> Vec<Value> {
    util::read_json(&meta_path(paths))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

pub fn write_meta(paths: &Paths, list: &[Value]) -> Result<(), String> {
    util::write_json(&meta_path(paths), &Value::Array(list.to_vec()))
}

pub fn pretty_name(entry: &Value) -> String {
    let raw = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let looks_like_file = raw.is_empty()
        || raw.to_lowercase().ends_with(".yaml")
        || raw.to_lowercase().ends_with(".yml")
        || regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-")
            .unwrap()
            .is_match(raw);
    if !looks_like_file {
        return raw.to_string();
    }
    let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let derived = util::subscription_display_name(url);
    if derived.is_empty() {
        if raw.is_empty() {
            "订阅".into()
        } else {
            raw.to_string()
        }
    } else {
        derived
    }
}

pub fn should_refresh_info(entry: &Value, now: i64) -> bool {
    if entry.get("url").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return false;
    }
    let last = entry
        .get("metadataCheckedAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    now - last >= METADATA_REFRESH_COOLDOWN_MS
}

/// 一次性迁移：旧 UUID 文件名 → 可读域名，并同步档案索引。
pub fn normalize_meta(paths: &Paths) {
    let mut list = read_meta(paths);
    if list.is_empty() {
        return;
    }
    let mut changed = false;
    for entry in list.iter_mut() {
        let pretty = pretty_name(entry);
        let old = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if pretty != old {
            changed = true;
            entry["name"] = json!(pretty);
        }
        if let Some(url) = entry.get("url").and_then(|v| v.as_str()) {
            crate::profiles::rename_by_url(paths, url, &pretty, false);
        }
    }
    if changed {
        let _ = write_meta(paths, &list);
    }
}

/// 合并一条订阅元数据：同 URL 覆盖、置顶、最多 20 条。
pub fn upsert_meta(
    paths: &Paths,
    url: &str,
    name: &str,
    userinfo: Option<Value>,
    next_update_at: i64,
) -> Result<Value, String> {
    let now = util::now_ms();
    let mut list = read_meta(paths);
    let prev = list
        .iter()
        .find(|x| x.get("url").and_then(|u| u.as_str()) == Some(url))
        .cloned();
    let mut entry = Map::new();
    entry.insert("url".into(), json!(url));
    entry.insert("name".into(), json!(name));
    entry.insert("updatedAt".into(), json!(now));
    entry.insert("metadataCheckedAt".into(), json!(now));
    entry.insert("nextUpdateAt".into(), json!(next_update_at));
    entry.insert("lastError".into(), json!(""));
    if let Some(u) = userinfo {
        entry.insert("userinfo".into(), u);
    } else if let Some(u) = prev.as_ref().and_then(|p| p.get("userinfo")) {
        entry.insert("userinfo".into(), u.clone());
    }
    let entry = Value::Object(entry);
    let mut next: Vec<Value> = vec![entry.clone()];
    next.extend(
        list.drain(..)
            .filter(|x| x.get("url").and_then(|u| u.as_str()) != Some(url)),
    );
    next.truncate(20);
    write_meta(paths, &next)?;
    Ok(entry)
}

/// 精确的 Base64 解码（保持与 Node Buffer 一致的宽松度）。
pub fn decode_base64_str(s: &str) -> String {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default()
}
