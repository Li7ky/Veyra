#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod commands;
mod conflict;
mod core;
mod enhance;
mod exitip;
mod profiles;
mod singbox;
mod state;
mod streaming;
mod subscription;
mod sysproxy;
mod tray;
mod update;
mod uri;
mod util;

use serde_json::Value;
use state::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[tauri::command]
async fn veyra_call(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    commands::dispatch(&app, &state, &method, &args).await
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn resources_root(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources")
    } else {
        app.path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

/// 热键注册：设置变更后整体重绑（与 Electron registerHotkeys 等价）。
pub async fn register_hotkeys(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    let settings = st.inner.lock().await.settings.clone();
    let _ = app.global_shortcut().unregister_all();
    let bindings = [
        (
            settings
                .get("hotkeyToggleProxy")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            "toggle-proxy",
        ),
        (
            settings
                .get("hotkeyToggleWindow")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            "toggle-window",
        ),
        (
            settings
                .get("hotkeyModeRule")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            "mode-rule",
        ),
        (
            settings
                .get("hotkeyModeGlobal")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            "mode-global",
        ),
        (
            settings
                .get("hotkeyModeDirect")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            "mode-direct",
        ),
    ];
    for (accel, action) in bindings {
        if accel.trim().is_empty() {
            continue;
        }
        let action = action.to_string();
        let accel = accel.trim().to_string();
        if app
            .global_shortcut()
            .on_shortcut(accel.as_str(), move |app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let app = app.clone();
                let action = action.clone();
                tauri::async_runtime::spawn(async move {
                    let st = app.state::<AppState>();
                    match action.as_str() {
                        "toggle-window" => {
                            if let Some(w) = app.get_webview_window("main") {
                                if w.is_visible().unwrap_or(false) {
                                    let _ = w.hide();
                                } else {
                                    show_main(&app);
                                }
                            }
                        }
                        "mode-rule" | "mode-global" | "mode-direct" => {
                            let mode = action.trim_start_matches("mode-").to_string();
                            let _ = core::set_core_mode(&app, &st, &mode).await;
                            tray::update_tray(&app);
                        }
                        _ => {
                            let (sys_on, online, pac_mode) = {
                                let i = st.inner.lock().await;
                                (
                                    i.sys_proxy_on,
                                    i.online,
                                    i.settings.get("proxyMode").and_then(|v| v.as_str()) == Some("pac"),
                                )
                            };
                            let _ = if sys_on {
                                core::set_system_proxy(&app, &st, false).await
                            } else if online {
                                core::apply_proxy_mode(
                                    &app,
                                    &st,
                                    if pac_mode { "pac" } else { "system" },
                                    false,
                                )
                                .await
                            } else {
                                Ok(Value::Null)
                            };
                            tray::update_tray(&app);
                        }
                    }
                });
            })
            .is_err()
        {
            eprintln!("[veyra] 热键注册失败: {}", accel);
        }
    }
    Ok(())
}

fn cleanup_update_scripts() {
    let dir = std::env::temp_dir();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if regex::Regex::new(r"(?i)^veyra-update-\d+\.cmd$")
                .map(|re| re.is_match(&name))
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

fn main() {
    let launched_hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![veyra_call])
        .setup(move |app| {
            let handle = app.handle().clone();
            let paths = state::Paths::new(resources_root(&handle));
            if let Err(e) = paths.ensure() {
                eprintln!("[veyra] 初始化配置目录失败: {}", e);
            }
            app.manage(AppState::new(paths));
            let _ = profiles::migrate_legacy_files(&handle.state::<AppState>().paths);
            cleanup_update_scripts();

            if let Err(e) = tray::create_tray(&handle) {
                eprintln!("[veyra] 托盘创建失败: {}", e);
            }

            let hide_on_start = {
                let st = handle.state::<AppState>();
                let settings = st
                    .inner
                    .try_lock()
                    .map(|i| i.settings.clone())
                    .unwrap_or_else(|_| state::defaults());
                let lightweight = settings
                    .get("lightweightMode")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let start_min = settings
                    .get("startMinimized")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                lightweight || (start_min && launched_hidden)
            };
            if hide_on_start {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            // 启动期同步注册表状态，再决定是否恢复系统代理。
            let handle2 = handle.clone();
            tauri::async_runtime::spawn(async move {
                let st = handle2.state::<AppState>();
                let _ = register_hotkeys(&handle2).await;
                let _ = core::sync_system_proxy_state(&handle2, &st).await;
                // 启动前互斥：外部系统代理生效时不自动拉起内核，交由前端弹窗处理。
                let report = startup_conflict(&handle2).await;
                let conflicts = report
                    .get("conflicts")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                if !conflicts.is_empty() {
                    let data = serde_json::json!({
                        "conflicts": conflicts,
                        "severity": "high",
                        "rawConflicts": report.get("rawConflicts").cloned().unwrap_or(serde_json::json!([])),
                        "at": util::iso_now(),
                    });
                    {
                        let mut i = st.inner.lock().await;
                        i.startup_conflict = Some(data.clone());
                    }
                    let _ = tauri::Emitter::emit(&handle2, "conflict:blockStartup", data);
                } else if let Err(e) = core::start(&handle2, &st).await {
                    eprintln!("[veyra] 内核启动失败: {}", e);
                    let _ = tauri::Emitter::emit(&handle2, "core:error", e);
                } else {
                    // 上次退出时系统代理开着 → 内核起来后自动恢复
                    let (last, mode, online) = {
                        let i = st.inner.lock().await;
                        (
                            i.settings.get("lastProxyOn").and_then(|v| v.as_bool()).unwrap_or(false),
                            i.settings
                                .get("proxyMode")
                                .and_then(|v| v.as_str())
                                .unwrap_or("system")
                                .to_string(),
                            i.online,
                        )
                    };
                    if last && online {
                        let m = if mode == "pac" { "pac" } else { "system" };
                        let _ = core::apply_proxy_mode(&handle2, &st, m, false).await;
                    }
                }
                core::start_proxy_guard(&handle2, &st);
                tray::update_tray(&handle2);

                // 启动 6s 后静默检查更新
                tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                if let Ok(info) = update::check_app_update(&st).await {
                    if info.get("hasUpdate").and_then(|v| v.as_bool()).unwrap_or(false) {
                        let _ = tauri::Emitter::emit(&handle2, "app:updateAvailable", info);
                    }
                }
                // 静默补齐订阅流量/到期信息
                let _ = st;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Veyra-omini");
}

async fn startup_conflict(app: &AppHandle) -> Value {
    let st = app.state::<AppState>();
    // 复用 commands 里的启动互斥逻辑：这里只做一次完整扫描并以系统代理为准。
    let (own, mixed, ctrl) = {
        let i = st.inner.lock().await;
        (
            i.own_core_pids.clone(),
            i.mixed_port,
            i.controller
                .rsplit(':')
                .next()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0),
        )
    };
    let scan = conflict::full_scan(conflict::ScanOptions {
        my_ports: vec![mixed, ctrl],
        my_custom_ports: Vec::new(),
        include_system: false,
        include_system_proxy: true,
        own_pids: own,
        self_pid: std::process::id(),
    })
    .await;
    let (prefer, pac_port, saved) = {
        let i = st.inner.lock().await;
        (
            i.settings
                .get("mixedPort")
                .and_then(|v| v.as_u64())
                .unwrap_or(state::DEFAULT_MIXED as u64) as u16,
            i.pac_port,
            i.settings
                .get("proxyPacUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
    };
    let ports = sysproxy::proxy_ports(mixed, prefer);
    let conflicts: Vec<Value> = scan
        .get("conflicts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| {
            if c.get("type").and_then(|v| v.as_str()) != Some("system-proxy") {
                return false;
            }
            let server = c.get("server").and_then(|v| v.as_str()).unwrap_or("");
            let pac = c.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
            !sysproxy::is_our_server(server, &ports) && !sysproxy::is_our_pac(pac, pac_port, &saved)
        })
        .collect();
    let labels: Vec<String> = conflicts
        .iter()
        .map(|c| c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string())
        .collect();
    serde_json::json!({
        "conflicts": labels,
        "severity": if conflicts.is_empty() { "none" } else { "high" },
        "rawConflicts": conflicts,
    })
}
