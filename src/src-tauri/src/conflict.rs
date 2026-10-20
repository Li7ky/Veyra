//! 冲突检测引擎：端口 / 进程 / 系统代理 / DNS / 路由 + 运行时监控。
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

use crate::state::AppState;
use crate::sysproxy;
use crate::util;

pub const PROXY_PROCESS_DB: &[(&str, &str)] = &[
    ("clash.exe", "Clash for Windows"),
    ("clash-verge.exe", "Clash Verge Rev"),
    ("verge.exe", "Clash Verge"),
    ("verge-mihomo.exe", "Clash Verge 内核"),
    ("clash-rev.exe", "Clash.Rev"),
    ("clash-win.exe", "Clash Premium"),
    ("clash-mihomo.exe", "Clash Mihomo"),
    ("clashx-pro.exe", "ClashX Pro"),
    ("clashx.exe", "ClashX"),
    ("clash-service.exe", "Clash Service"),
    ("macha.exe", "Macha Clash"),
    ("v2rayn.exe", "v2rayN"),
    ("v2rayn-core.exe", "v2rayN Core"),
    ("v2ray.exe", "v2ray Core"),
    ("xray.exe", "Xray"),
    ("v2raya.exe", "v2rayA"),
    ("qv2ray.exe", "Qv2ray"),
    ("nekoray.exe", "NekoRay"),
    ("nekobox.exe", "NekoBox"),
    ("hysteria.exe", "Hysteria"),
    ("hysteria2.exe", "Hysteria2"),
    ("shadowsocks.exe", "Shadowsocks Windows"),
    ("shadowsocks-qt5.exe", "Shadowsocks-Qt5"),
    ("ss-local.exe", "Shadowsocks libev"),
    ("ssr-local.exe", "ShadowsocksR"),
    ("electron-ssr.exe", "electron-ssr"),
    ("sstap.exe", "SSTap"),
    ("trojan.exe", "Trojan"),
    ("trojan-go.exe", "Trojan-Go"),
    ("tuic.exe", "TUIC"),
    ("leaf.exe", "Leaf Proxy"),
    ("sing-box.exe", "sing-box (外部)"),
    ("mihomo.exe", "Mihomo (外部)"),
    ("dae.exe", "dae"),
    ("daed.exe", "daed"),
    ("netch.exe", "Netch"),
    ("sstap-beta.exe", "SSTap Beta"),
    ("privoxy.exe", "Privoxy"),
    ("proxifier.exe", "Proxifier"),
    ("proxifier64.exe", "Proxifier x64"),
    ("warp-svc.exe", "Cloudflare WARP"),
    ("cloudflare-warp.exe", "Cloudflare WARP GUI"),
    ("outline.exe", "Outline Client"),
    ("outline-service.exe", "Outline Service"),
];

pub const KNOWN_PROXY_PORTS: &[(u16, &str, &str)] = &[
    (7890, "Clash HTTP", "clash"),
    (7891, "Clash SOCKS", "clash"),
    (7892, "Clash Mixed", "clash"),
    (9090, "Clash API", "clash"),
    (9091, "Clash API (alt)", "clash"),
    (9097, "Clash Mixed (Verge)", "clash"),
    (9098, "Verge TUN DNS", "clash"),
    (3300, "Miyabei/Clash alt", "clash"),
    (10808, "v2rayN HTTP", "v2ray"),
    (10809, "v2rayN SOCKS", "v2ray"),
    (10810, "v2rayN Mixed", "v2ray"),
    (10813, "v2rayN Alt", "v2ray"),
    (15835, "v2rayA API", "v2ray"),
    (2017, "v2rayA Alt", "v2ray"),
    (1080, "通用 SOCKS", "v2ray"),
    (1081, "SOCKS alt", "v2ray"),
    (8080, "HTTP alt", "v2ray"),
    (3128, "Squid/Privoxy", "v2ray"),
    (10086, "NekoRay", "v2ray"),
    (65534, "SS Alt", "ss"),
    (443, "Trojan (shared with HTTPS)", "trojan"),
    (9099, "sing-box API", "other"),
    (8118, "Privoxy", "other"),
    (51820, "WireGuard TunSafe", "other"),
];

const FALSE_POSITIVE: &[&str] = &[
    "vmwp", "vmmem", "vmms", "hns", "wsl", "wslservice", "wslhost", "docker", "docker-desktop",
    "dockerd", "docker-desktop-ci", "com.docker", "vpnkit", "svchost", "mmcss", "lsass", "services",
    "wininit", "csrss", "smss", "conhost", "taskhostw", "sihost", "ctfmon", "dwm", "taskmgr",
    "fontdrvhost", "registry", "system", "idle", "nvcontainer", "igccservice", "onenote", "teams",
    "outlook", "chrome", "firefox", "msedge", "opera", "vivaldi", "brave",
];

async fn probe_port(port: u16, host: &str, timeout_ms: u64) -> bool {
    let addr = format!("{}:{}", host, port);
    matches!(
        tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            tokio::net::TcpStream::connect(&addr)
        )
        .await,
        Ok(Ok(_))
    )
}

pub async fn scan_ports(my_ports: &[u16]) -> Vec<Value> {
    let mut tasks = Vec::new();
    for (port, label, family) in KNOWN_PROXY_PORTS {
        if my_ports.contains(port) {
            continue;
        }
        let port = *port;
        let label = label.to_string();
        let family = family.to_string();
        tasks.push(async move {
            if probe_port(port, "127.0.0.1", 1200).await {
                return Some(json!({
                    "type": "port", "port": port, "label": label,
                    "family": family, "severity": "high",
                }));
            }
            if probe_port(port, "0.0.0.0", 800).await {
                return Some(json!({
                    "type": "port", "port": port, "label": format!("{} (全局)", label),
                    "family": family, "severity": "high",
                }));
            }
            None
        });
    }
    let results = futures_util::future::join_all(tasks).await;
    results.into_iter().flatten().collect()
}

pub async fn scan_custom_ports(ports: &[u16]) -> Vec<Value> {
    let mut tasks = Vec::new();
    for &port in ports {
        tasks.push(async move {
            if !probe_port(port, "127.0.0.1", 1200).await {
                return None;
            }
            let known = KNOWN_PROXY_PORTS.iter().find(|(p, _, _)| *p == port);
            match known {
                Some((_, label, family)) => Some(json!({
                    "type": "port", "port": port, "label": label,
                    "family": family, "severity": "critical",
                })),
                None => Some(json!({
                    "type": "port", "port": port,
                    "label": format!("端口 {} 被占用", port), "severity": "critical",
                })),
            }
        });
    }
    futures_util::future::join_all(tasks)
        .await
        .into_iter()
        .flatten()
        .collect()
}

pub fn detect_processes(own_pids: &[u32]) -> Vec<Value> {
    let Ok((stdout, _)) = util::run("tasklist", &["/fo", "csv", "/nh"]) else {
        return Vec::new();
    };
    let mut rows: Vec<(String, u32)> = Vec::new();
    let re = regex::Regex::new(r#"(?i)^"([^"]+)","(\d+)""#).unwrap();
    for line in stdout.lines() {
        if let Some(c) = re.captures(line) {
            if let (Some(name), Some(pid)) = (c.get(1), c.get(2)) {
                if let Ok(pid) = pid.as_str().parse::<u32>() {
                    rows.push((name.as_str().to_lowercase(), pid));
                }
            }
        }
    }
    let own: HashSet<u32> = own_pids.iter().copied().collect();
    let mut hits = Vec::new();
    let mut seen = HashSet::new();
    for (proc_name, label) in PROXY_PROCESS_DB {
        let name = proc_name.to_lowercase();
        let base = name.trim_end_matches(".exe");
        if FALSE_POSITIVE.contains(&base) {
            continue;
        }
        let matched: Vec<u32> = rows
            .iter()
            .filter(|(n, _)| *n == name)
            .map(|(_, pid)| *pid)
            .collect();
        if matched.is_empty() {
            continue;
        }
        if matched.iter().all(|p| own.contains(p)) {
            continue;
        }
        if !seen.insert(label.to_string()) {
            continue;
        }
        let external: Vec<u32> = matched.into_iter().filter(|p| !own.contains(p)).collect();
        hits.push(json!({
            "type": "process", "proc": base, "label": label,
            "pids": external, "severity": "medium",
        }));
    }
    hits
}

pub fn detect_system_proxy() -> Option<Value> {
    let raw = sysproxy::query_raw();
    let enabled = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let server = raw.get("server").and_then(|v| v.as_str()).unwrap_or("");
    let pac = raw.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
    if !enabled && pac.is_empty() {
        return None;
    }
    if !pac.is_empty() && !enabled {
        return Some(json!({
            "type": "system-proxy",
            "label": format!("系统 PAC 代理被占用 → {}", pac),
            "server": pac, "pacUrl": pac, "severity": "high",
        }));
    }
    let addr = if server.is_empty() { "未知" } else { server };
    Some(json!({
        "type": "system-proxy",
        "label": format!("系统代理被占用 → {}", addr),
        "server": addr, "pacUrl": pac, "severity": "high",
    }))
}

pub async fn detect_dns() -> Option<Value> {
    if probe_port(53, "127.0.0.1", 1000).await {
        Some(json!({
            "type": "dns", "label": "本地 DNS (127.0.0.1:53) 被占用", "severity": "high",
        }))
    } else {
        None
    }
}

pub fn detect_route() -> Option<Value> {
    let Ok((stdout, _)) = util::run("route", &["print", "-4"]) else {
        return None;
    };
    let re = regex::Regex::new(
        r"^0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d+)$",
    )
    .unwrap();
    for line in stdout.lines() {
        let line = line.trim();
        let Some(c) = re.captures(line) else { continue };
        let gateway = c.get(1).map(|m| m.as_str()).unwrap_or("");
        let iface = c.get(2).map(|m| m.as_str()).unwrap_or("");
        let metric: u32 = c
            .get(3)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
        if is_private_gateway(gateway) {
            continue;
        }
        if gateway == iface && metric < 10 {
            continue;
        }
        if gateway != "127.0.0.1" && iface != gateway {
            return Some(json!({
                "type": "route",
                "label": format!("检测到非标准默认网关 {}（可能为 VPN 隧道）", gateway),
                "gateway": gateway, "severity": "medium",
            }));
        }
        if metric > 500 {
            return Some(json!({
                "type": "route",
                "label": format!("默认网关 metric 异常 ({})，可能为 VPN 隧道", metric),
                "gateway": gateway, "severity": "medium",
            }));
        }
    }
    None
}

pub fn is_private_gateway(ip: &str) -> bool {
    let parts: Vec<u32> = ip.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 4 {
        return false;
    }
    let (a, b) = (parts[0], parts[1]);
    a == 10
        || (a == 192 && b == 168)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 169 && b == 254)
        || a == 0
        || a == 127
}

pub fn dedupe(items: Vec<Value>) -> (Vec<Value>, Value, String, Value) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let mut critical = 0;
    let mut high = 0;
    let mut medium = 0;
    for mut item in items {
        let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let port = item.get("port").and_then(|v| v.as_u64());
        let proc = item.get("proc").and_then(|v| v.as_str()).map(|s| s.to_string());
        let label = item.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let ident = if let Some(p) = port {
            format!("port:{}", p)
        } else if let Some(p) = proc {
            format!("proc:{}", p)
        } else {
            format!("label:{}", label)
        };
        let key = format!("{}:{}", ty, ident);
        let alt = if ty == "process" { label.clone() } else { ident.clone() };
        if seen.contains(&key) || seen.contains(&alt) {
            continue;
        }
        seen.insert(key);
        seen.insert(alt);
        let severity = item
            .get("severity")
            .and_then(|v| v.as_str())
            .unwrap_or("medium")
            .to_string();
        if item.get("severity").is_none() {
            item["severity"] = json!("medium");
        }
        match severity.as_str() {
            "critical" => critical += 1,
            "high" => high += 1,
            _ => medium += 1,
        }
        out.push(item);
    }
    let severity = if critical > 0 {
        "critical"
    } else if high > 0 {
        "high"
    } else if medium > 0 {
        "medium"
    } else {
        "none"
    };
    let summary = if out.is_empty() {
        "✓ 未检测到其他代理软件".to_string()
    } else {
        let labels: Vec<String> = out
            .iter()
            .map(|c| c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string())
            .collect();
        format!(
            "检测到 {} 个可能的冲突：{}",
            out.len(),
            labels.join("、")
        )
    };
    (
        out,
        json!({"critical": critical, "high": high, "medium": medium}),
        severity.to_string(),
        json!(summary),
    )
}

pub struct ScanOptions {
    pub my_ports: Vec<u16>,
    pub my_custom_ports: Vec<u16>,
    pub include_system: bool,
    pub include_system_proxy: bool,
    pub own_pids: Vec<u32>,
    pub self_pid: u32,
}

pub async fn full_scan(opts: ScanOptions) -> Value {
    let mut found: Vec<Value> = Vec::new();
    if let Some(mut hit) = detect_self_conflict(opts.self_pid) {
        hit["severity"] = json!("critical");
        found.push(hit);
    }
    let (ports, procs, custom) = futures_util::future::join3(
        scan_ports(&opts.my_ports),
        async { detect_processes(&opts.own_pids) },
        scan_custom_ports(&opts.my_custom_ports),
    )
    .await;
    found.extend(ports);
    found.extend(procs);
    found.extend(custom);
    if opts.include_system || opts.include_system_proxy {
        let sys_proxy = detect_system_proxy();
        let dns = if opts.include_system { detect_dns().await } else { None };
        let route = if opts.include_system { detect_route() } else { None };
        if let Some(v) = sys_proxy {
            found.push(v);
        }
        if let Some(v) = dns {
            found.push(v);
        }
        if let Some(v) = route {
            found.push(v);
        }
    }
    let (conflicts, counts, severity, summary) = dedupe(found);
    json!({
        "conflicts": conflicts,
        "summary": summary,
        "severity": severity,
        "counts": counts,
    })
}

// ── 自身标识 ─────────────────────────────────────────────
fn id_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("veyra-omini-id")
}
fn marker_path() -> std::path::PathBuf {
    id_dir().join("instance.json")
}

pub fn register_self_identity(
    pid: u32,
    mixed_port: u16,
    controller: &str,
    secret: &str,
    core_mode: &str,
    version: &str,
) -> Option<Value> {
    let _ = std::fs::create_dir_all(id_dir());
    let session = uuid::Uuid::new_v4().to_string().replace('-', "");
    let payload = json!({
        "app": "Veyra-omini",
        "version": version,
        "pid": pid,
        "mixedPort": mixed_port,
        "controllerPort": controller,
        "secret": secret,
        "coreMode": core_mode,
        "startedAt": util::iso_now(),
        "session": &session[..16],
    });
    let text = serde_json::to_string_pretty(&payload).ok()?;
    let tmp = marker_path().with_extension("json.tmp");
    std::fs::write(&tmp, text).ok()?;
    let _ = std::fs::rename(&tmp, marker_path());
    Some(payload)
}

pub fn unregister_self_identity() {
    let _ = std::fs::remove_file(marker_path());
}

pub fn get_self_identity() -> Option<Value> {
    util::read_json(&marker_path())
}

pub fn detect_self_conflict(self_pid: u32) -> Option<Value> {
    let payload = get_self_identity()?;
    let pid = payload.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if pid == 0 || pid == self_pid {
        return None;
    }
    let running = util::run("tasklist", &["/fi", &format!("PID eq {}", pid), "/fo", "csv", "/nh"])
        .map(|(out, _)| out.contains(&format!("\"{}\"", pid)))
        .unwrap_or(false);
    if running {
        Some(json!({
            "type": "self",
            "label": format!("Veyra-omini 已在运行 (PID {})", pid),
            "pid": pid,
            "severity": "medium",
        }))
    } else {
        let _ = std::fs::remove_file(marker_path());
        None
    }
}

pub fn kill_pids(pids: &[u32]) -> Value {
    let mut killed = Vec::new();
    let mut failed = Vec::new();
    for pid in pids {
        match util::run("taskkill", &["/pid", &pid.to_string(), "/f", "/t"]) {
            Ok(_) => killed.push(*pid),
            Err(_) => failed.push(*pid),
        }
    }
    json!({ "killed": killed, "failed": failed })
}

/// 启动运行时监控：每 5s 扫描一次，只在冲突集合变化时推送事件。
pub fn start_monitor(app: tauri::AppHandle, interval_ms: u64) {
    use tauri::{Emitter, Manager};
    stop_monitor(&app);
    let app_after = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut last_keys: HashSet<String> = HashSet::new();
        let mut first_done = false;
        let mut conflict_stopped = false;
        loop {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            let (own_pids, running, mixed, ctrl, self_pid, prefer, pac_port, saved_pac, settings) = {
                let i = state.inner.lock().await;
                let ctrl = i
                    .controller
                    .rsplit(':')
                    .next()
                    .and_then(|s| s.parse::<u16>().ok())
                    .unwrap_or(0);
                (
                    i.own_core_pids.clone(),
                    i.online || i.core.is_some(),
                    i.mixed_port,
                    ctrl,
                    std::process::id(),
                    i.settings
                        .get("mixedPort")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(17897) as u16,
                    i.pac_port,
                    i.settings
                        .get("proxyPacUrl")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    i.settings.clone(),
                )
            };
            let my_custom = if running { Vec::new() } else { vec![mixed, ctrl] };
            let mut scan = full_scan(ScanOptions {
                my_ports: vec![mixed, ctrl],
                my_custom_ports: my_custom,
                include_system: false,
                include_system_proxy: true,
                own_pids,
                self_pid,
            })
            .await;
            // 只排除「自家系统代理」，其余端口/进程/DNS/路由冲突保留。
            if let Some(list) = scan.get_mut("conflicts").and_then(|v| v.as_array_mut()) {
                let ports = sysproxy::proxy_ports(mixed, prefer);
                list.retain(|c| {
                    if c.get("type").and_then(|t| t.as_str()) != Some("system-proxy") {
                        return true;
                    }
                    let server = c.get("server").and_then(|v| v.as_str()).unwrap_or("");
                    let pac = c.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
                    !sysproxy::is_our_server(server, &ports)
                        && !sysproxy::is_our_pac(pac, pac_port, &saved_pac)
                });
            }
            let conflicts = scan
                .get("conflicts")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let key = |c: &Value| {
                format!(
                    "{}:{}",
                    c.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                    c.get("proc")
                        .or_else(|| c.get("port"))
                        .map(|v| v.to_string())
                        .unwrap_or_default()
                )
            };
            let cur: HashSet<String> = conflicts.iter().map(key).collect();
            if !first_done {
                last_keys = cur;
                first_done = true;
                continue;
            }
            let new_items: Vec<&Value> = conflicts
                .iter()
                .filter(|c| !last_keys.contains(&key(c)))
                .collect();
            let resolved: Vec<String> = last_keys
                .iter()
                .filter(|k| !cur.contains(*k))
                .cloned()
                .collect();
            if !new_items.is_empty() {
                let critical: Vec<&Value> = new_items
                    .iter()
                    .filter(|c| c.get("severity").and_then(|v| v.as_str()) == Some("critical"))
                    .copied()
                    .collect();
                let high: Vec<&Value> = new_items
                    .iter()
                    .filter(|c| c.get("severity").and_then(|v| v.as_str()) == Some("high"))
                    .copied()
                    .collect();
                let medium: Vec<&Value> = new_items
                    .iter()
                    .filter(|c| {
                        !matches!(
                            c.get("severity").and_then(|v| v.as_str()),
                            Some("critical") | Some("high")
                        )
                    })
                    .copied()
                    .collect();
                if !critical.is_empty() {
                    let labels: Vec<String> = critical
                        .iter()
                        .map(|c| c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string())
                        .collect();
                    let _ = app.emit(
                        "conflict:detected",
                        json!({"items": labels, "severity": "critical", "at": util::iso_now()}),
                    );
                    if !conflict_stopped {
                        conflict_stopped = true;
                        let st = app.state::<AppState>();
                        let _ = crate::core::stop(&app, &st).await;
                    }
                } else if !high.is_empty() {
                    let labels: Vec<String> = high
                        .iter()
                        .map(|c| c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string())
                        .collect();
                    let _ = app.emit(
                        "conflict:detected",
                        json!({"items": labels, "severity": "high", "at": util::iso_now()}),
                    );
                } else if !medium.is_empty() {
                    let labels: Vec<String> = medium
                        .iter()
                        .map(|c| c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string())
                        .collect();
                    let _ = app.emit(
                        "core:log",
                        format!(
                            "[veyra] 检测到其他代理软件运行（{}），但未检测到端口冲突，和平共处。\n",
                            labels.join("、")
                        ),
                    );
                }
            }
            if !resolved.is_empty() {
                let still = !conflicts.is_empty();
                let _ = app.emit(
                    "conflict:resolved",
                    json!({
                        "at": util::iso_now(),
                        "autoRecover": conflict_stopped && !still,
                        "remaining": conflicts.iter().map(|c| {
                            c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string()
                        }).collect::<Vec<_>>(),
                    }),
                );
                if conflict_stopped && !still {
                    conflict_stopped = false;
                    let st = app.state::<AppState>();
                    let _ = crate::core::start(&app, &st).await;
                }
            }
            last_keys = cur;
            let _ = settings;
        }
    });
    if let Some(st) = app_after.try_state::<AppState>() {
        if let Ok(mut guard) = st.monitor_task.lock() {
            *guard = Some(handle);
        }
    }
}

pub fn stop_monitor(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(st) = app.try_state::<AppState>() {
        if let Ok(mut guard) = st.monitor_task.lock() {
            if let Some(h) = guard.take() {
                h.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_keeps_types_separate() {
        let items = vec![
            json!({"type": "system-proxy", "label": "a", "severity": "high"}),
            json!({"type": "dns", "label": "b", "severity": "high"}),
            json!({"type": "route", "label": "c", "severity": "medium"}),
        ];
        let (out, counts, severity, _) = dedupe(items);
        assert_eq!(out.len(), 3);
        assert_eq!(counts["high"], 2);
        assert_eq!(severity, "high");
    }

    #[test]
    fn private_gateways() {
        assert!(is_private_gateway("192.168.1.1"));
        assert!(is_private_gateway("10.0.0.1"));
        assert!(!is_private_gateway("8.8.8.8"));
    }
}
