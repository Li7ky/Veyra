//! Windows 系统代理：注册表、PAC 本地服务、代理守护（对齐 Electron sysproxy + verge-ext）。
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use crate::state::{AppState, DEFAULT_MIXED};
use crate::util;

pub const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

pub fn refresh_wininet() {
    let script = r#"Add-Type -Namespace Veyra -Name WinInet -MemberDefinition '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'; [void][Veyra.WinInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0); [void][Veyra.WinInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)"#;
    let _ = util::powershell(script);
}

fn reg(args: &[&str]) {
    let _ = util::run("reg", args);
}

/// 读取原始代理状态（不判断归属）。
pub fn query_raw() -> Value {
    let mut enabled = false;
    let mut server = String::new();
    let mut pac = String::new();
    if let Ok(text) = util::run("reg", &["query", KEY]) {
        for line in text.0.lines() {
            let t = line.trim_start();
            let value = |rest: &str| -> String {
                rest.split("REG_SZ")
                    .nth(1)
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default()
            };
            if let Some(rest) = t.strip_prefix("ProxyEnable") {
                if rest.contains("0x1") {
                    enabled = true;
                }
            } else if let Some(rest) = t.strip_prefix("ProxyServer") {
                server = value(rest);
            } else if let Some(rest) = t.strip_prefix("AutoConfigURL") {
                pac = value(rest);
            }
        }
    }
    if !pac.is_empty() && !pac.contains("://") {
        pac.clear();
    }
    json!({
        "enabled": enabled,
        "server": server,
        "pacUrl": pac,
    })
}

pub fn proxy_ports(mixed: u16, preferred: u16) -> Vec<u16> {
    vec![
        mixed,
        DEFAULT_MIXED,
        preferred,
        DEFAULT_MIXED.saturating_add(10003),
        preferred.saturating_add(10003),
    ]
}

pub fn is_our_server(server: &str, ports: &[u16]) -> bool {
    let re = regex::Regex::new(r"(?i)(?:127\.0\.0\.1|localhost)\s*:\s*(\d+)").unwrap();
    let mut found = false;
    for c in re.captures_iter(server) {
        let ok = c
            .get(1)
            .and_then(|m| m.as_str().parse::<u16>().ok())
            .map(|p| ports.contains(&p))
            .unwrap_or(false);
        if ok {
            found = true;
            break;
        }
    }
    found
}

pub fn is_our_pac(pac: &str, pac_port: u16, saved: &str) -> bool {
    let value = pac.trim();
    if value.is_empty() {
        return false;
    }
    if !saved.trim().is_empty() && value == saved.trim() {
        return true;
    }
    if let Ok(u) = url::Url::parse(value) {
        if let Some(host) = u.host_str() {
            if host == "127.0.0.1" || host == "localhost" {
                if let Some(port) = u.port() {
                    return pac_port > 0 && port == pac_port;
                }
            }
        }
    }
    false
}

/// 对外「enabled」只表示 Veyra 接管的系统代理。
pub fn status(st: &AppState) -> Value {
    let raw = query_raw();
    let (mixed, prefer, pac_port, saved_pac) = {
        let i = st.inner.blocking_lock();
        (
            i.mixed_port,
            i.settings
                .get("mixedPort")
                .and_then(|v| v.as_u64())
                .unwrap_or(DEFAULT_MIXED as u64) as u16,
            i.pac_port,
            i.settings
                .get("proxyPacUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
    };
    let ports = proxy_ports(mixed, prefer);
    let enabled = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let server = raw.get("server").and_then(|v| v.as_str()).unwrap_or("");
    let pac = raw.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
    let ours = (enabled && is_our_server(server, &ports)) || is_our_pac(pac, pac_port, &saved_pac);
    json!({
        "enabled": ours,
        "server": server,
        "pacUrl": pac,
        "rawEnabled": enabled,
        "ours": ours,
    })
}

pub async fn status_async(st: &AppState) -> Value {
    let raw = query_raw();
    let (mixed, prefer, pac_port, saved_pac) = {
        let i = st.inner.lock().await;
        (
            i.mixed_port,
            i.settings
                .get("mixedPort")
                .and_then(|v| v.as_u64())
                .unwrap_or(DEFAULT_MIXED as u64) as u16,
            i.pac_port,
            i.settings
                .get("proxyPacUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
    };
    let ports = proxy_ports(mixed, prefer);
    let enabled = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let server = raw.get("server").and_then(|v| v.as_str()).unwrap_or("");
    let pac = raw.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
    let ours = (enabled && is_our_server(server, &ports)) || is_our_pac(pac, pac_port, &saved_pac);
    json!({
        "enabled": ours,
        "server": server,
        "pacUrl": pac,
        "rawEnabled": enabled,
        "ours": ours,
    })
}

pub fn pac_script(port: u16) -> String {
    format!(
        "function FindProxyForURL(url, host) {{\n  if (isPlainHostName(host) || host === \"127.0.0.1\" || host === \"localhost\") return \"DIRECT\";\n  if (shExpMatch(host, \"10.*\") || shExpMatch(host, \"192.168.*\") || shExpMatch(host, \"172.16.*\")) return \"DIRECT\";\n  return \"PROXY 127.0.0.1:{port}; DIRECT\";\n}}\n",
        port = port
    )
}

/// 启动 PAC 服务，返回端口。停止旧服务由调用方负责。
pub async fn start_pac_server(st: &AppState, mixed_port: u16) -> Result<u16, String> {
    stop_pac_server(st);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let shared = Arc::new(AtomicU16::new(mixed_port));
    {
        let mut i = st.inner.lock().await;
        i.pac_port = port;
    }
    let shared2 = shared.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let shared = shared2.clone();
            tauri::async_runtime::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let body = pac_script(shared.load(Ordering::Relaxed));
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    if let Ok(mut guard) = st.pac_task.lock() {
        *guard = Some(handle);
    }
    Ok(port)
}

pub fn stop_pac_server(st: &AppState) {
    if let Ok(mut guard) = st.pac_task.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }
    if let Ok(mut i) = st.inner.try_lock() {
        i.pac_port = 0;
    }
}

pub fn set(mode: &str, mixed_port: u16, bypass: &str, pac_port: u16) -> Result<Value, String> {
    match mode {
        "off" => {
            reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
            reg(&["delete", KEY, "/v", "AutoConfigURL", "/f"]);
            refresh_wininet();
            Ok(json!({ "ok": true, "mode": "off" }))
        }
        "pac" => {
            let url = format!("http://127.0.0.1:{}/proxy.pac", pac_port);
            reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
            reg(&["add", KEY, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", &url, "/f"]);
            refresh_wininet();
            Ok(json!({ "ok": true, "mode": "pac", "pacUrl": url }))
        }
        _ => {
            let server = format!("127.0.0.1:{}", mixed_port);
            reg(&["delete", KEY, "/v", "AutoConfigURL", "/f"]);
            reg(&["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", &server, "/f"]);
            reg(&["add", KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", bypass, "/f"]);
            reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]);
            refresh_wininet();
            Ok(json!({ "ok": true, "mode": "system", "server": server, "bypass": bypass }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_server_matches_ports() {
        assert!(is_our_server("127.0.0.1:17897", &[17897, 19097]));
        assert!(!is_our_server("127.0.0.1:7890", &[17897, 19097]));
    }

    #[test]
    fn pac_url_matches() {
        assert!(is_our_pac("http://127.0.0.1:5555/proxy.pac", 5555, ""));
        assert!(!is_our_pac("http://127.0.0.1:5555/proxy.pac", 6666, ""));
    }
}
