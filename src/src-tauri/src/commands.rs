//! Tauri IPC 分发：把前端 `window.veyra.*` 映射到 Rust 实现。
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use crate::backup;
use crate::conflict;
use crate::core;
use crate::enhance;
use crate::exitip;
use crate::profiles;
use crate::singbox;
use crate::state::{self, AppState, Paths};
use crate::streaming;
use crate::subscription;
use crate::sysproxy;
use crate::update;
use crate::uri;
use crate::util;

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}
fn str_arg(args: &[Value], i: usize) -> String {
    arg(args, i).as_str().unwrap_or("").to_string()
}
fn bool_arg(args: &[Value], i: usize) -> bool {
    arg(args, i).as_bool().unwrap_or(false)
}

fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub async fn dispatch(
    app: &AppHandle,
    st: &AppState,
    method: &str,
    args: &[Value],
) -> Result<Value, String> {
    let win = app.get_webview_window("main");
    match method {
        // ── 窗口 ─────────────────────────────────────────────
        "minimize" => {
            if let Some(w) = &win {
                let _ = w.minimize();
            }
            Ok(Value::Null)
        }
        "maximize" | "isMaximized" => Ok(json!(false)),
        "close" => {
            let close_to_tray = {
                let i = st.inner.lock().await;
                i.settings
                    .get("closeToTray")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true)
            };
            if close_to_tray {
                if let Some(w) = &win {
                    let _ = w.hide();
                }
                crate::tray::notify(app, "Veyra-omini 已最小化到托盘，代理仍在后台运行");
            } else {
                // 直接退出：先把系统代理收掉、把内核停掉，再退出。
                // 否则窗口关了但 mihomo 还在跑、注册表 ProxyEnable 仍指向它，
                // 下次启动只能以「收养」方式接管，且用户浏览器会指向一个没人管的端口。
                let _ = core::set_system_proxy(app, st, false).await;
                let _ = core::stop(app, st).await;
                app.exit(0);
            }
            Ok(Value::Null)
        }
        "windowDragStart" => {
            if let Some(w) = &win {
                let pos = w.outer_position().unwrap_or_default();
                let mut d = st.drag.lock().map_err(|e| e.to_string())?;
                *d = Some(state::DragState {
                    start_x: arg(args, 0).as_f64().unwrap_or(0.0),
                    start_y: arg(args, 1).as_f64().unwrap_or(0.0),
                    win_x: pos.x,
                    win_y: pos.y,
                });
            }
            Ok(Value::Null)
        }
        "windowDragMove" => {
            if let Some(w) = &win {
                let d = st.drag.lock().map_err(|e| e.to_string())?;
                if let Some(d) = d.as_ref() {
                    let x = d.win_x + (arg(args, 0).as_f64().unwrap_or(0.0) - d.start_x) as i32;
                    let y = d.win_y + (arg(args, 1).as_f64().unwrap_or(0.0) - d.start_y) as i32;
                    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            Ok(Value::Null)
        }
        "windowDragEnd" => {
            if let Ok(mut d) = st.drag.lock() {
                *d = None;
            }
            Ok(Value::Null)
        }

        // ── 设置 ─────────────────────────────────────────────
        "getSettings" => Ok(st.inner.lock().await.settings.clone()),
        "setSettings" => {
            let mut patch = arg(args, 0);
            if let Some(obj) = patch.as_object_mut() {
                if let Some(pw) = obj.get("webdavPass").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                    if !pw.is_empty() && !pw.starts_with("enc:") {
                        obj.insert("webdavPass".into(), json!(backup::obscure_secret(&pw)));
                    }
                }
            }
            let next = {
                let mut i = st.inner.lock().await;
                state::merge_patch(&mut i.settings, &patch);
                refresh_runtime_fields(&mut i);
                state::save_settings(&st.paths.settings, &i.settings)?;
                i.settings.clone()
            };
            if patch.get("startWithWindows").is_some() {
                apply_autostart(app, &next);
            }
            if patch.get("proxyGuard").is_some() || patch.get("proxyMode").is_some() {
                core::start_proxy_guard(app, st);
            }
            if patch.as_object().map(|o| {
                o.keys().any(|k| k.starts_with("hotkey"))
            }).unwrap_or(false) {
                let _ = crate::register_hotkeys(app).await;
            }
            if patch.get("lightweightMode").is_some() {
                crate::tray::set_lightweight(
                    app,
                    st,
                    next.get("lightweightMode").and_then(|v| v.as_bool()).unwrap_or(false),
                )
                .await;
            }
            let keys = [
                "bindAddress",
                "allowLan",
                "unifiedDelay",
                "tcpConcurrent",
                "mixedPort",
                "controllerPort",
                "secret",
                "logLevel",
                "core",
            ];
            let need_enhance = patch.as_object().map(|o| {
                o.keys().any(|k| {
                    keys.contains(&k.as_str())
                        || ["tun", "dns", "sniff"]
                            .iter()
                            .any(|p| k.to_lowercase().starts_with(p))
                })
            }).unwrap_or(false);
            if need_enhance {
                let _ = core::run_enhance_and_reload(app, st).await;
            }
            crate::tray::update_tray(app);
            Ok(next)
        }
        "resetSettings" => {
            let next = {
                let mut i = st.inner.lock().await;
                let keep_core = i.settings.get("core").cloned().unwrap_or(json!("mihomo"));
                let keep_bounds = i.settings.get("windowBounds").cloned().unwrap_or(Value::Null);
                let keep_seen = i.settings.get("seenVersion").cloned();
                let mut next = state::defaults();
                next["core"] = keep_core;
                next["windowBounds"] = keep_bounds;
                if let Some(seen) = keep_seen {
                    next["seenVersion"] = seen;
                }
                i.settings = next;
                refresh_runtime_fields(&mut i);
                state::save_settings(&st.paths.settings, &i.settings)?;
                i.settings.clone()
            };
            apply_autostart(app, &next);
            core::start_proxy_guard(app, st);
            let _ = crate::register_hotkeys(app).await;
            let _ = core::run_enhance_and_reload(app, st).await;
            crate::tray::update_tray(app);
            Ok(next)
        }
        "applyNetwork" => {
            st.paths.ensure()?;
            let patch = arg(args, 0);
            let mut warnings = Vec::new();
            let mut clean = patch.as_object().cloned().unwrap_or_default();
            let allow_lan = st
                .inner
                .lock()
                .await
                .settings
                .get("allowLan")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            for key in ["mixedPort", "controllerPort"] {
                if let Some(v) = clean.get(key).and_then(|x| x.as_u64()) {
                    if v < 1 || v > 65535 || !state::port_usable(v as u16, allow_lan) {
                        warnings.push(format!("端口 {} 已被占用或无效，已保留原值", v));
                        clean.remove(key);
                    }
                }
            }
            if let Some(s) = clean.get("secret").and_then(|v| v.as_str()) {
                if s.trim().is_empty() {
                    warnings.push("Secret 不能为空，已保留原值".into());
                    clean.remove("secret");
                }
            }
            let (mixed, controller, running, was_proxy) = {
                let mut i = st.inner.lock().await;
                state::merge_patch(&mut i.settings, &Value::Object(clean));
                refresh_runtime_fields(&mut i);
                state::save_settings(&st.paths.settings, &i.settings)?;
                (i.mixed_port, i.controller.clone(), i.online || i.core.is_some(), i.sys_proxy_on)
            };
            if !running {
                let (m, c) = {
                    let mut i = st.inner.lock().await;
                    let allow = i.settings.get("allowLan").and_then(|v| v.as_bool()).unwrap_or(false);
                    let prefer = i.settings.get("mixedPort").and_then(|v| v.as_u64()).unwrap_or(17897) as u16;
                    let ctrl_want = i.settings.get("controllerPort").and_then(|v| v.as_u64()).unwrap_or(19097) as u16;
                    let mixed = state::pick_port(prefer, allow).unwrap_or(prefer);
                    let ctrl = state::pick_port(ctrl_want, allow).unwrap_or(ctrl_want);
                    i.mixed_port = mixed;
                    i.controller = format!("127.0.0.1:{}", ctrl);
                    (i.mixed_port, i.controller.clone())
                };
                {
                    let i = st.inner.lock().await;
                    let _ = core::patch_runtime_ports(&st.paths, &i);
                }
                let _ = (m, c);
            } else {
                let _ = core::stop(app, st).await;
                let _ = core::start(app, st).await;
                if was_proxy {
                    let _ = core::apply_proxy_mode(app, st, "system", false).await;
                }
            }
            crate::tray::update_tray(app);
            Ok(json!({
                "settings": st.inner.lock().await.settings.clone(),
                "mixedPort": mixed,
                "controller": controller,
                "warnings": warnings,
            }))
        }
        "openPath" => {
            let which = str_arg(args, 0);
            let (target, select) = match which.as_str() {
                "config" => (st.paths.config_dir.clone(), false),
                "bin" => (st.paths.bin.clone(), true),
                "settings" => (st.paths.settings.clone(), true),
                _ => (st.paths.user_data.clone(), false),
            };
            if !select {
                let _ = fs::create_dir_all(&target);
            }
            let mut cmd = std::process::Command::new("explorer.exe");
            if select && target.exists() {
                cmd.arg(format!("/select,{}", target.to_string_lossy()));
            } else {
                cmd.arg(&target);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let _ = cmd.spawn();
            Ok(json!({ "ok": true, "path": target.to_string_lossy() }))
        }
        "copyText" => {
            let text = str_arg(args, 0);
            let _ = arboard::Clipboard::new().and_then(|mut c| c.set_text(text));
            Ok(json!({ "ok": true }))
        }

        // ── 应用信息 / 更新日志 ──────────────────────────────
        "appInfo" => Ok(app_info(st)),
        "changelog" => Ok(changelog()),
        "updateNotes" => {
            let list = changelog();
            let current = app_version();
            let seen = st
                .inner
                .lock()
                .await
                .settings
                .get("seenVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut entry = list
                .as_array()
                .and_then(|a| {
                    a.iter()
                        .find(|e| e.get("version").and_then(|v| v.as_str()) == Some(current))
                })
                .cloned()
                .unwrap_or(Value::Null);
            if entry.is_null() && seen != current && !seen.is_empty() {
                if let Some(cached) = util::read_json(&st.paths.update_notes_cache) {
                    if cached.get("version").and_then(|v| v.as_str()) == Some(current) {
                        entry = cached;
                    }
                }
            }
            Ok(json!({
                "current": current,
                "seen": seen,
                "isNew": !seen.is_empty() && seen != current,
                "entry": entry,
            }))
        }
        "markVersionSeen" => {
            let mut i = st.inner.lock().await;
            if let Some(o) = i.settings.as_object_mut() {
                o.insert("seenVersion".into(), json!(app_version()));
            }
            state::save_settings(&st.paths.settings, &i.settings)?;
            Ok(json!({ "ok": true }))
        }
        "checkAppUpdate" => update::check_app_update(st).await,
        "downloadAppUpdate" => update::download_app_update(app, st).await,
        "installAppUpdate" => update::install_app_update(app, st, &str_arg(args, 0)).await,
        "cancelAppUpdate" => {
            st.inner.lock().await.update_cancel = true;
            Ok(json!({ "ok": true }))
        }

        // ── 内核 ─────────────────────────────────────────────
        "startCore" | "coreStart" => {
            let report = check_conflicts_for_start(st).await;
            let labels = report
                .get("conflicts")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if !labels.is_empty() {
                let names: Vec<String> = labels
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                let msg = format!(
                    "检测到其他软件已启用系统代理：{}。已阻止启动，请先停止外部系统代理并退出对应软件后重试。",
                    names.join("、")
                );
                let data = json!({
                    "conflicts": names, "severity": report.get("severity").cloned().unwrap_or(json!("high")),
                    "rawConflicts": report.get("rawConflicts").cloned().unwrap_or(json!([])),
                    "at": util::iso_now(),
                });
                st.inner.lock().await.startup_conflict = Some(data.clone());
                let _ = app.emit("conflict:blockStartup", data);
                crate::tray::notify(app, &msg);
                return Err(msg);
            }
            core::start(app, st).await
        }
        "stopCore" | "coreStop" => {
            let _ = core::stop(app, st).await;
            Ok(json!({ "running": false, "sysProxy": false }))
        }
        "restartCore" | "coreRestart" => core::restart(app, st).await,
        "coreStatus" => Ok(core::status(app, st).await),
        "coreInfo" => {
            let mut info = core::core_info(st).await;
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            let api_version = core::api(&controller, &secret, "/version", "GET", None)
                .await
                .ok()
                .unwrap_or(Value::Null);
            info["apiVersion"] = api_version;
            Ok(info)
        }
        "checkCoreUpdate" => {
            let core = st.inner.lock().await.active_core.clone();
            update::check_core_update(st, &core).await
        }
        "updateCore" | "matchCoreBuild" => {
            let core = st.inner.lock().await.active_core.clone();
            update::update_core_binary(app, st, &core).await
        }
        "switchCore" => core::switch_core(app, st, &str_arg(args, 0)).await,
        "coreList" => Ok(core::core_list(st).await),

        // ── 代理 / 连接 / 规则 ───────────────────────────────
        "ports" => {
            let i = st.inner.lock().await;
            Ok(json!({
                "mixedPort": i.mixed_port,
                "controller": i.controller,
                "preferredPort": i.settings.get("mixedPort").and_then(|v| v.as_u64()).unwrap_or(17897),
            }))
        }
        "overview" => {
            let (controller, secret, mixed, preferred) = {
                let i = st.inner.lock().await;
                (
                    i.controller.clone(),
                    i.secret.clone(),
                    i.mixed_port,
                    i.settings.get("mixedPort").and_then(|v| v.as_u64()).unwrap_or(17897),
                )
            };
            let (proxies, configs, connections) = futures_util::future::join3(
                core::api(&controller, &secret, "/proxies", "GET", None),
                core::api(&controller, &secret, "/configs", "GET", None),
                core::api(&controller, &secret, "/connections", "GET", None),
            )
            .await;
            let raw = connections.unwrap_or_else(|_| json!({}));
            let mut list = raw
                .get("connections")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            list.sort_by(|a, b| {
                b.get("start")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .cmp(a.get("start").and_then(|v| v.as_str()).unwrap_or(""))
            });
            let total = list.len();
            let peak = list
                .iter()
                .filter_map(|c| c.get("upload").and_then(|v| v.as_u64()).or_else(|| c.get("download").and_then(|v| v.as_u64())))
                .max()
                .unwrap_or(0);
            list.truncate(80);
            let (sys_total_mem, sys_used_mem) = system_mem();
            Ok(json!({
                "proxies": proxies.unwrap_or(Value::Null),
                "configs": configs.unwrap_or(Value::Null),
                "connections": {
                    "uploadTotal": raw.get("uploadTotal").cloned().unwrap_or(json!(0)),
                    "downloadTotal": raw.get("downloadTotal").cloned().unwrap_or(json!(0)),
                    "connections": list,
                },
                "connectionsCount": total,
                "mixedPort": mixed,
                "controller": controller,
                "preferredPort": preferred,
                "coreMemoryMB": core_memory_mb(st).await,
                "systemTotalMem": sys_total_mem,
                "systemUsedMem": sys_used_mem,
                "peak": peak,
            }))
        }
        "selectProxy" => {
            let group = str_arg(args, 0);
            let name = str_arg(args, 1);
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            core::api(
                &controller,
                &secret,
                &format!("/proxies/{}", util::percent_encode(&group)),
                "PUT",
                Some(json!({ "name": name })),
            )
            .await
        }
        "testDelay" => {
            let name = str_arg(args, 0);
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            let url = util::percent_encode("https://www.gstatic.com/generate_204");
            match core::api(
                &controller,
                &secret,
                &format!("/proxies/{}/delay?timeout=5000&url={}", util::percent_encode(&name), url),
                "GET",
                None,
            )
            .await
            {
                Ok(v) => Ok(json!({ "status": 200, "data": v })),
                Err(e) => Ok(json!({ "status": 0, "data": { "delay": 0 }, "error": e })),
            }
        }
        "setMode" => {
            let mode = str_arg(args, 0);
            core::set_core_mode(app, st, &mode).await
        }
        "patchConfig" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            core::api(&controller, &secret, "/configs", "PATCH", Some(arg(args, 0))).await
        }
        "setSystemProxy" => core::set_system_proxy(app, st, bool_arg(args, 0)).await,
        "systemProxyStatus" => {
            let st_json = sysproxy::status_async(st).await;
            let ours = st_json.get("ours").and_then(|v| v.as_bool()).unwrap_or(false);
            st.inner.lock().await.sys_proxy_on = ours;
            Ok(json!({
                "enabled": ours,
                "server": st_json.get("server").cloned().unwrap_or(json!("")),
                "rawEnabled": st_json.get("rawEnabled").cloned().unwrap_or(json!(false)),
            }))
        }
        "listConnections" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            core::api(&controller, &secret, "/connections", "GET", None)
                .await
                .map(|v| {
                    if v.is_null() {
                        json!({"connections":[]})
                    } else {
                        v
                    }
                })
        }
        "closeAllConnections" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            core::api(&controller, &secret, "/connections", "DELETE", None).await
        }
        "closeConnection" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            core::api(
                &controller,
                &secret,
                &format!("/connections/{}", util::percent_encode(&str_arg(args, 0))),
                "DELETE",
                None,
            )
            .await
        }
        "listRules" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            match core::api(&controller, &secret, "/rules", "GET", None).await {
                Ok(v) => Ok(if v.is_null() { json!({"rules":[]}) } else { v }),
                Err(_) => {
                    let text = util::read_text(&st.paths.runtime).unwrap_or_default();
                    let cfg: Value = serde_yaml::from_str(&text).unwrap_or_else(|_| json!({}));
                    let rules: Vec<Value> = cfg
                        .get("rules")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .map(|r| json!({"payload": r.as_str().unwrap_or(""), "type": "Rule", "size": 0}))
                                .collect()
                        })
                        .unwrap_or_default();
                    Ok(json!({ "rules": rules }))
                }
            }
        }
        "saveVisualRules" => {
            let arr: Vec<String> = arg(args, 0)
                .as_array()
                .map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect())
                .unwrap_or_default();
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            if let Ok(cur) = core::api(&controller, &secret, "/rules", "GET", None).await {
                let cur_arr: Vec<String> = cur
                    .get("rules")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|r| {
                                if let Some(s) = r.as_str() {
                                    Some(s.to_string())
                                } else {
                                    r.get("payload")
                                        .or_else(|| r.get("rule"))
                                        .and_then(|x| x.as_str())
                                        .map(|s| s.to_string())
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if cur_arr.len() == arr.len() && cur_arr.iter().zip(arr.iter()).all(|(a, b)| a == b) {
                    return Ok(json!({ "ok": true, "unchanged": true, "warnings": [] }));
                }
            }
            let name = "visual-rules";
            let existing = profiles::list_rich(&st.paths)
                .into_iter()
                .find(|p| {
                    p.get("type").and_then(|v| v.as_str()) == Some("rules")
                        && p.get("name").and_then(|v| v.as_str()) == Some(name)
                });
            let body = format!(
                "rules:\n{}\n",
                arr.iter()
                    .map(|r| format!("  - {}", serde_json::to_string(r).unwrap_or_else(|_| "\"\"".into())))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            if let Some(item) = existing {
                let uid = item.get("uid").and_then(|v| v.as_str()).unwrap_or("");
                profiles::write_content(&st.paths, uid, &body)?;
                profiles::set_enabled(&st.paths, uid, true)?;
            } else {
                let item = profiles::create_enhance(&st.paths, "rules", name, true)?;
                let uid = item.get("uid").and_then(|v| v.as_str()).unwrap_or("");
                profiles::write_content(&st.paths, uid, &body)?;
            }
            let (_, warnings, _) = core::run_enhance_and_reload(app, st).await?;
            Ok(json!({ "ok": true, "warnings": warnings }))
        }
        "listProviders" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            let (pp, rp) = futures_util::future::join(
                core::api(&controller, &secret, "/providers/proxies", "GET", None),
                core::api(&controller, &secret, "/providers/rules", "GET", None),
            )
            .await;
            Ok(json!({
                "proxies": pp.ok().and_then(|v| v.get("providers").cloned()).unwrap_or(json!({})),
                "rules": rp.ok().and_then(|v| v.get("providers").cloned()).unwrap_or(json!({})),
            }))
        }
        "updateProvider" => {
            let kind = str_arg(args, 0);
            let name = str_arg(args, 1);
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            let path = if kind == "rules" {
                format!("/providers/rules/{}", util::percent_encode(&name))
            } else {
                format!("/providers/proxies/{}", util::percent_encode(&name))
            };
            core::api(&controller, &secret, &path, "PUT", None).await
        }

        // ── 档案 / 订阅 ─────────────────────────────────────
        "listProfiles" => {
            st.paths.ensure()?;
            profiles::migrate_legacy_files(&st.paths);
            let rich = profiles::list_rich(&st.paths);
            if !rich.is_empty() {
                let items: Vec<Value> = rich
                    .iter()
                    .map(|p| {
                        let file = p.get("file").and_then(|v| v.as_str()).unwrap_or("");
                        json!({
                            "name": p.get("name").cloned().unwrap_or(Value::Null),
                            "path": st.paths.profiles_dir.join(file).to_string_lossy(),
                            "size": p.get("size").cloned().unwrap_or(json!(0)),
                            "uid": p.get("uid").cloned().unwrap_or(Value::Null),
                            "type": p.get("type").cloned().unwrap_or(json!("local")),
                            "enabled": p.get("enabled").cloned().unwrap_or(json!(true)),
                            "global": p.get("global").cloned().unwrap_or(json!(false)),
                            "url": p.get("url").cloned().unwrap_or(Value::Null),
                            "updatedAt": p.get("updatedAt").cloned().unwrap_or(json!(0)),
                        })
                    })
                    .collect();
                return Ok(Value::Array(items));
            }
            Ok(Value::Array(profiles::fallback_files(&st.paths)))
        }
        "listProfilesRich" => {
            st.paths.ensure()?;
            profiles::migrate_legacy_files(&st.paths);
            Ok(Value::Array(profiles::list_rich(&st.paths)))
        }
        "importProfile" => {
            let payload = arg(args, 0);
            let content = payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if content.trim().is_empty() {
                return Err("配置内容不能为空".into());
            }
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("local");
            core::apply_profile_content(app, st, name, &content, "local", None).await
        }
        "importProfileUrl" => import_profile_url(app, st, arg(args, 0)).await,
        "setNextUpdate" => {
            let url = str_arg(args, 0);
            if url.trim().is_empty() {
                return Err("订阅地址无效".into());
            }
            let next = arg(args, 1).as_i64().unwrap_or(0);
            let mut list = subscription::read_meta(&st.paths);
            for e in list.iter_mut() {
                if e.get("url").and_then(|u| u.as_str()) == Some(url.as_str()) {
                    e["nextUpdateAt"] = json!(next);
                }
            }
            subscription::write_meta(&st.paths, &list)?;
            Ok(json!({ "ok": true }))
        }
        "listSubscriptions" => {
            subscription::normalize_meta(&st.paths);
            let list = subscription::read_meta(&st.paths);
            let out: Vec<Value> = list
                .iter()
                .map(|e| {
                    let mut v = e.clone();
                    v["name"] = json!(subscription::pretty_name(e));
                    v
                })
                .collect();
            Ok(Value::Array(out))
        }
        "refreshMissingSubInfo" => refresh_missing_subs(st).await,
        "removeSubscription" => {
            st.paths.ensure()?;
            let url = str_arg(args, 0);
            if url.trim().is_empty() {
                return Err("订阅地址无效".into());
            }
            let idx = profiles::load_index(&st.paths);
            let active = idx.get("active").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let prof = idx
                .get("items")
                .and_then(|v| v.as_array())
                .and_then(|a| {
                    a.iter().find(|x| {
                        x.get("type").and_then(|t| t.as_str()) == Some("remote")
                            && x.get("url").and_then(|u| u.as_str()) == Some(url.as_str())
                    })
                })
                .cloned();
            let was_active = prof
                .as_ref()
                .map(|p| p.get("uid").and_then(|u| u.as_str()) == Some(active.as_str()))
                .unwrap_or(false);
            if let Some(uid) = prof.as_ref().and_then(|p| p.get("uid")).and_then(|v| v.as_str()) {
                profiles::delete_profile(&st.paths, uid);
            }
            let list: Vec<Value> = subscription::read_meta(&st.paths)
                .into_iter()
                .filter(|e| e.get("url").and_then(|u| u.as_str()) != Some(url.as_str()))
                .collect();
            let _ = subscription::write_meta(&st.paths, &list);
            if was_active {
                if profiles::active_uid(&st.paths).is_none() {
                    let def = st.paths.resources.join("config").join("default.yaml");
                    if def.exists() {
                        let _ = fs::copy(&def, &st.paths.runtime);
                    }
                }
                let _ = core::run_enhance_and_reload(app, st).await;
            }
            Ok(json!({ "ok": true, "removedProfile": prof.is_some(), "wasActive": was_active }))
        }
        "activateProfile" => {
            st.paths.ensure()?;
            let idx = profiles::set_active(&st.paths, &str_arg(args, 0))?;
            let (_, warnings, logs) = core::run_enhance_and_reload(app, st).await?;
            Ok(json!({ "ok": true, "index": idx, "warnings": warnings, "scriptLogs": logs }))
        }
        "setProfileEnabled" => {
            st.paths.ensure()?;
            profiles::set_enabled(&st.paths, &str_arg(args, 0), bool_arg(args, 1))
        }
        "createEnhanceProfile" => {
            st.paths.ensure()?;
            profiles::create_enhance(
                &st.paths,
                &str_arg(args, 0),
                &str_arg(args, 1),
                bool_arg(args, 2),
            )
        }
        "deleteProfile" => {
            st.paths.ensure()?;
            profiles::delete_profile(&st.paths, &str_arg(args, 0));
            Ok(json!({ "ok": true }))
        }
        "readProfile" => {
            st.paths.ensure()?;
            Ok(json!(profiles::read_content(&st.paths, &str_arg(args, 0))?))
        }
        "writeProfile" => {
            st.paths.ensure()?;
            profiles::write_content(&st.paths, &str_arg(args, 0), &str_arg(args, 1))?;
            let _ = core::run_enhance_and_reload(app, st).await;
            Ok(json!({ "ok": true }))
        }
        "setProfileBinds" => {
            st.paths.ensure()?;
            profiles::set_profile_binds(&st.paths, &str_arg(args, 0), &arg(args, 1))
        }
        "enhancePreview" => {
            st.paths.ensure()?;
            profiles::migrate_legacy_files(&st.paths);
            let opts = {
                let i = st.inner.lock().await;
                core::enhance_opts(&i)
            };
            let (text, warnings, logs) = enhance::enhance(&st.paths, &opts)?;
            Ok(json!({ "yaml": text, "warnings": warnings, "scriptLogs": logs }))
        }
        "enhanceApply" => {
            let (text, warnings, logs) = core::run_enhance_and_reload(app, st).await?;
            Ok(json!({ "ok": true, "bytes": text.len(), "warnings": warnings, "scriptLogs": logs }))
        }
        "readRuntime" => Ok(json!(util::read_text(&st.paths.runtime).unwrap_or_default())),
        "writeRuntime" => {
            util::atomic_write_text(&st.paths.runtime, &str_arg(args, 0))?;
            core::reload_runtime_config(app, st).await;
            Ok(json!({ "ok": true }))
        }
        "readActiveProfile" | "profileReadActive" => {
            st.paths.ensure()?;
            if st.paths.runtime.exists() {
                Ok(json!(util::read_text(&st.paths.runtime).unwrap_or_default()))
            } else {
                Ok(json!(profiles::active_main_text(&st.paths).unwrap_or_default()))
            }
        }

        // ── 服务 / 备份 / WebDAV / UWP ───────────────────────
        "setProxyMode" => core::apply_proxy_mode(app, st, &str_arg(args, 0), false).await,
        "validateDns" => Ok(backup::validate_dns(&str_arg(args, 0))),
        "serviceStatus" => Ok(backup::service_status()),
        "serviceInstall" => service_install(app, st).await,
        "serviceUninstall" => {
            let r = backup::uninstall_service();
            if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                let mut i = st.inner.lock().await;
                if let Some(o) = i.settings.as_object_mut() {
                    o.insert("serviceMode".into(), json!(false));
                }
                let _ = state::save_settings(&st.paths.settings, &i.settings);
            }
            Ok(r)
        }
        "enableUwpLoopback" => backup::enable_uwp_loopback(),
        "backupExport" => Ok(backup::export_backup_zip(&st.paths)?),
        "backupImport" => {
            let picked = app
                .dialog()
                .file()
                .add_filter("ZIP", &["zip"])
                .blocking_pick_file();
            let Some(path) = picked else {
                return Ok(json!({ "ok": false, "canceled": true }));
            };
            let path = path
                .into_path()
                .map_err(|e| format!("路径无效：{}", e))?;
            let r = backup::import_backup_zip(&path, &st.paths)?;
            reload_settings_preserving(st).await;
            let _ = core::run_enhance_and_reload(app, st).await;
            Ok(r)
        }
        "backupReveal" => {
            let _ = fs::create_dir_all(&st.paths.backups);
            let mut cmd = std::process::Command::new("explorer.exe");
            cmd.arg(&st.paths.backups);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let _ = cmd.spawn();
            Ok(json!({ "ok": true, "path": st.paths.backups.to_string_lossy() }))
        }
        "webdavUpload" => {
            let s = reload_settings_preserving(st).await;
            let exp = backup::export_backup_zip(&st.paths)?;
            let body = fs::read(exp.get("path").and_then(|v| v.as_str()).unwrap_or(""))
                .map_err(|e| e.to_string())?;
            backup::webdav_put(
                s.get("webdavUrl").and_then(|v| v.as_str()).unwrap_or(""),
                s.get("webdavUser").and_then(|v| v.as_str()).unwrap_or(""),
                &backup::reveal_secret(s.get("webdavPass").and_then(|v| v.as_str()).unwrap_or("")),
                body,
                s.get("webdavRemote").and_then(|v| v.as_str()).unwrap_or("veyra-backup.zip"),
            )
            .await
        }
        "webdavDownload" => {
            let s = reload_settings_preserving(st).await;
            let body = backup::webdav_get(
                s.get("webdavUrl").and_then(|v| v.as_str()).unwrap_or(""),
                s.get("webdavUser").and_then(|v| v.as_str()).unwrap_or(""),
                &backup::reveal_secret(s.get("webdavPass").and_then(|v| v.as_str()).unwrap_or("")),
                s.get("webdavRemote").and_then(|v| v.as_str()).unwrap_or("veyra-backup.zip"),
            )
            .await?;
            let tmp = st.paths.user_data.join("webdav-restore.zip");
            fs::write(&tmp, body).map_err(|e| e.to_string())?;
            let r = backup::import_backup_zip(&tmp, &st.paths)?;
            reload_settings_preserving(st).await;
            let _ = core::run_enhance_and_reload(app, st).await;
            Ok(r)
        }
        "exitIp" => {
            let (mixed, via) = {
                let i = st.inner.lock().await;
                (
                    i.mixed_port,
                    i.sys_proxy_on || i.settings.get("tunEnable").and_then(|v| v.as_bool()).unwrap_or(false),
                )
            };
            let info = exitip::fetch_exit_ip(mixed, via).await;
            let mut out = info;
            out["viaProxy"] = json!(via);
            Ok(out)
        }

        // ── 冲突 / 诊断 ──────────────────────────────────────
        "detectProxyConflict" => {
            let scan = scan_conflicts(st, false, false).await;
            let labels: Vec<String> = scan
                .get("conflicts")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .map(|c| c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string())
                        .collect()
                })
                .unwrap_or_default();
            Ok(Value::Array(labels.into_iter().map(Value::String).collect()))
        }
        "fullConflictScan" => {
            let (controller, secret, mixed) = {
                let i = st.inner.lock().await;
                (
                    i.controller.clone(),
                    i.secret.clone(),
                    i.mixed_port,
                )
            };
            let running = core::api(&controller, &secret, "/version", "GET", None)
                .await
                .is_ok();
            let ctrl = controller
                .rsplit(':')
                .next()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);
            let opts = conflict::ScanOptions {
                my_ports: vec![mixed, ctrl],
                my_custom_ports: if running { Vec::new() } else { vec![mixed, ctrl] },
                include_system: true,
                include_system_proxy: true,
                own_pids: st.inner.lock().await.own_core_pids.clone(),
                self_pid: std::process::id(),
            };
            Ok(conflict::full_scan(opts).await)
        }
        "checkPorts" => {
            let (mixed, preferred_mixed, preferred_ctrl, running, ctrl) = {
                let i = st.inner.lock().await;
                (
                    i.mixed_port,
                    i.settings.get("mixedPort").and_then(|v| v.as_u64()).unwrap_or(17897) as u16,
                    i.settings.get("controllerPort").and_then(|v| v.as_u64()).unwrap_or(19097) as u16,
                    i.online || i.core.is_some(),
                    i.controller
                        .rsplit(':')
                        .next()
                        .and_then(|s| s.parse::<u16>().ok())
                        .unwrap_or(0),
                )
            };
            let allow = st
                .inner
                .lock()
                .await
                .settings
                .get("allowLan")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Ok(json!({
                "mixedPort": mixed,
                "controllerPort": ctrl,
                "preferredMixedPort": preferred_mixed,
                "preferredControllerPort": preferred_ctrl,
                "mixedFree": state::port_usable(mixed, allow),
                "ctrlFree": state::port_usable(ctrl, allow),
                "running": running,
                "drifted": running && (mixed != preferred_mixed || ctrl != preferred_ctrl),
            }))
        }
        "startConflictMonitor" => {
            if bool_arg(args, 0) {
                conflict::start_monitor(app.clone(), 5000);
            } else {
                conflict::stop_monitor(app);
            }
            Ok(json!({ "ok": true }))
        }
        "getSelfIdentity" => Ok(conflict::get_self_identity().unwrap_or(Value::Null)),
        "resolveExternalProxy" => resolve_external_proxy(app, st).await,
        "killProxyProcesses" => {
            let pids: Vec<u32> = arg(args, 0)
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
                .unwrap_or_default();
            Ok(conflict::kill_pids(&pids))
        }
        "retryStartAfterConflict" => {
            let report = check_conflicts_for_start(st).await;
            let conflicts = report.get("conflicts").cloned().unwrap_or(json!([]));
            if conflicts.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                return Ok(json!({
                    "ok": false, "conflicts": conflicts,
                    "severity": report.get("severity").cloned().unwrap_or(json!("high")),
                }));
            }
            match core::start(app, st).await {
                Ok(_) => Ok(json!({ "ok": true, "severity": report.get("severity").cloned().unwrap_or(json!("none")) })),
                Err(e) => Ok(json!({ "ok": false, "error": e, "severity": "none" })),
            }
        }

        // ── 解锁测试 / 杂项 ──────────────────────────────────
        "streamingUnlock" | "streaming" => {
            let mixed = st.inner.lock().await.mixed_port;
            Ok(streaming::run_all(mixed).await)
        }
        "streamingUnlockOne" => {
            let mixed = st.inner.lock().await.mixed_port;
            streaming::run_one(mixed, &str_arg(args, 0)).await
        }
        "unlockCatalog" => Ok(streaming::catalog()),
        "proxyEnvText" => {
            let mixed = st.inner.lock().await.mixed_port;
            Ok(json!({ "text": backup::proxy_env_text(mixed) }))
        }
        "importNodeUri" => {
            let parsed = uri::parse_node_uri(&str_arg(args, 0))?;
            let doc = uri::proxy_to_yaml_doc(&parsed)?;
            let name = format!(
                "{}.yaml",
                doc.get("name").and_then(|v| v.as_str()).unwrap_or("node")
            );
            let content = doc.get("content").and_then(|v| v.as_str()).unwrap_or("");
            core::apply_profile_content(app, st, &name, content, "local", None).await
        }
        "vcRuntime" => Ok(backup::vc_runtime()),
        "downloadVc" => {
            let _ = open::that("https://aka.ms/vs/17/release/vc_redist.x64.exe");
            Ok(json!({ "ok": true }))
        }
        "openWebUI" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            let (host, port) = controller.split_once(':').unwrap_or(("127.0.0.1", "19097"));
            let secret = util::percent_encode(&secret);
            let url = match str_arg(args, 0).as_str() {
                "yacd" => format!(
                    "https://yacd.haishan.me/?hostname={}&port={}&secret={}",
                    host, port, secret
                ),
                "zashboard" => format!(
                    "https://board.zash.run.place/#/setup?hostname={}&port={}&secret={}",
                    host, port, secret
                ),
                _ => format!(
                    "https://metacubex.github.io/metacubexd/#/setup?hostname={}&port={}&secret={}",
                    host, port, secret
                ),
            };
            let _ = open::that(&url);
            Ok(json!({ "ok": true, "url": url }))
        }
        "openExternal" => {
            let url = str_arg(args, 0);
            let parsed = url::Url::parse(&url).map_err(|_| "外部链接无效".to_string())?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err("仅允许打开 HTTP/HTTPS 链接".into());
            }
            let _ = open::that(parsed.as_str());
            Ok(Value::Null)
        }
        "clearLogFiles" => {
            let days = st
                .inner
                .lock()
                .await
                .settings
                .get("logAutoCleanDays")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let now = util::now_ms();
            let mut removed = 0u32;
            if let Ok(rd) = fs::read_dir(&st.paths.logs) {
                for e in rd.flatten() {
                    let path = e.path();
                    if !path.is_file() {
                        continue;
                    }
                    let old = fs::metadata(&path)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    if days == 0 || now - old > days * 86_400_000 {
                        if fs::remove_file(&path).is_ok() {
                            removed += 1;
                        }
                    }
                }
            }
            Ok(json!({ "ok": true, "removed": removed }))
        }
        "getLogHistory" => {
            use crate::core::log_ring;
            let lines: Vec<String> = log_ring()
                .lock()
                .map(|g| g.iter().cloned().collect())
                .unwrap_or_default();
            Ok(json!({ "lines": lines }))
        }
        "traffic" => {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            Ok(core::api(&controller, &secret, "/connections", "GET", None)
                .await
                .unwrap_or(Value::Null))
        }

        _ => Err(format!("未实现的方法：{}", method)),
    }
}

fn refresh_runtime_fields(inner: &mut state::Inner) {
    inner.mixed_port = inner
        .settings
        .get("mixedPort")
        .and_then(|v| v.as_u64())
        .unwrap_or(state::DEFAULT_MIXED as u64) as u16;
    let ctrl = inner
        .settings
        .get("controllerPort")
        .and_then(|v| v.as_u64())
        .unwrap_or(state::DEFAULT_CTRL as u64) as u16;
    inner.controller = format!("127.0.0.1:{}", ctrl);
    inner.secret = inner
        .settings
        .get("secret")
        .and_then(|v| v.as_str())
        .unwrap_or("veyra-secret")
        .to_string();
    inner.active_core = if inner.settings.get("core").and_then(|v| v.as_str()) == Some("singbox") {
        "singbox".into()
    } else {
        "mihomo".into()
    };
}

fn apply_autostart(app: &AppHandle, settings: &Value) {
    let enabled = settings
        .get("startWithWindows")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}

async fn reload_settings_preserving(st: &AppState) -> Value {
    let next = state::load_settings(&st.paths.settings);
    let mut i = st.inner.lock().await;
    let running = i.online || i.core.is_some();
    let (mixed, controller, secret, core) = (
        i.mixed_port,
        i.controller.clone(),
        i.secret.clone(),
        i.active_core.clone(),
    );
    i.settings = next;
    if running {
        i.mixed_port = mixed;
        i.controller = controller;
        i.secret = secret;
        i.active_core = core;
    } else {
        refresh_runtime_fields(&mut i);
    }
    i.settings.clone()
}

async fn core_memory_mb(st: &AppState) -> Value {
    let pid = st.inner.lock().await.core.as_ref().map(|c| c.id());
    let Some(pid) = pid else {
        return Value::Null;
    };
    let Ok((out, _)) = util::run(
        "tasklist",
        &["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"],
    ) else {
        return Value::Null;
    };
    let re = regex::Regex::new(r#""([\d,]+)\s*K""#).unwrap();
    re.captures(&out)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().replace(',', "").parse::<u64>().ok())
        .map(|kb| json!((kb / 1024) as u64))
        .unwrap_or(Value::Null)
}

/// 物理内存 (总量, 已用)，单位字节。
/// 直接问内核（GlobalMemoryStatusEx），比起一个 PowerShell 进程便宜得多，
/// 所以可以挂在 1.5s 一次的 overview 里，让侧栏和首页的数字保持实时。
#[cfg(windows)]
fn system_mem() -> (u64, u64) {
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut m = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut m) };
    if ok == 0 || m.ull_total_phys == 0 {
        (0, 0)
    } else {
        (
            m.ull_total_phys,
            m.ull_total_phys.saturating_sub(m.ull_avail_phys),
        )
    }
}

#[cfg(not(windows))]
fn system_mem() -> (u64, u64) {
    (0, 0)
}

fn app_info(st: &AppState) -> Value {
    let os_release = util::run("cmd", &["/c", "ver"]).ok()
        .map(|(o, _)| o.trim().to_string())
        .unwrap_or_default();
    let (total_mem, used_mem) = system_mem();
    // 系统版本：EditionID 是注册表里的英文枚举（Professional / Core …），不随系统语言变，
    // 用它拼「Windows 10 Pro」；Caption 在中文系统是 GBK，跨进程读回来会乱码。
    let edition = util::powershell(
        "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').EditionID",
    )
    .ok()
    .map(|s| s.trim().to_string())
    .unwrap_or_default();
    // 版本号取自 ver 输出的 x.y.<build>.<rev>
    let build = os_release
        .split('.')
        .nth(2)
        .map(|s| s.trim_end_matches(|c: char| !c.is_ascii_digit()).to_string())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let os_base = if build >= 22000 { "Windows 11" } else { "Windows 10" };
    let edition_short = match edition.as_str() {
        "Professional" | "ProfessionalN" => "Pro",
        "ProfessionalEducation" => "Pro Education",
        "ProfessionalWorkstation" | "ProfessionalWorkstationN" => "Pro for Workstations",
        "Core" | "CoreN" | "CoreSingleLanguage" | "CoreCountrySpecific" => "Home",
        "Education" | "EducationN" => "Education",
        "Enterprise" | "EnterpriseN" => "Enterprise",
        "EnterpriseS" | "EnterpriseSN" => "Enterprise LTSC",
        "IoTEnterprise" => "IoT Enterprise",
        "ServerStandard" => "Server Standard",
        _ => "",
    };
    let os_name = if edition_short.is_empty() {
        os_base.to_string()
    } else {
        format!("{} {}", os_base, edition_short)
    };
    json!({
        "name": "Veyra-omini",
        "version": app_version(),
        "electron": "Tauri 2",
        "chrome": "",
        "node": "",
        "platform": if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" },
        "arch": if std::env::consts::ARCH == "x86_64" { "x64" } else { std::env::consts::ARCH },
        "isDev": cfg!(debug_assertions),
        "userData": st.paths.user_data.to_string_lossy(),
        "osRelease": os_release,
        "osVersion": os_release,
        "osName": os_name,
        "totalMem": total_mem,
        "usedMem": used_mem,
        "cpu": std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default(),
    })
}

fn changelog() -> Value {
    serde_json::from_str(include_str!("../data/changelog.json")).unwrap_or_else(|_| json!([]))
}

async fn scan_conflicts(st: &AppState, include_system: bool, include_system_proxy: bool) -> Value {
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
    conflict::full_scan(conflict::ScanOptions {
        my_ports: vec![mixed, ctrl],
        my_custom_ports: Vec::new(),
        include_system,
        include_system_proxy,
        own_pids: own,
        self_pid: std::process::id(),
    })
    .await
}

/// 启动前互斥：只阻止「外部软件已实际接管系统代理」。
async fn check_conflicts_for_start(st: &AppState) -> Value {
    let scan = scan_conflicts(st, false, true).await;
    let mut conflicts: Vec<Value> = scan
        .get("conflicts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let process_hits: Vec<Value> = conflicts
        .iter()
        .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some("process"))
        .cloned()
        .collect();
    let (mixed, prefer, pac_port, saved) = {
        let i = st.inner.lock().await;
        (
            i.mixed_port,
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
    conflicts.retain(|c| {
        if c.get("type").and_then(|v| v.as_str()) != Some("system-proxy") {
            return false;
        }
        let server = c.get("server").and_then(|v| v.as_str()).unwrap_or("");
        let pac = c.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
        !sysproxy::is_our_server(server, &ports) && !sysproxy::is_our_pac(pac, pac_port, &saved)
    });
    if !process_hits.is_empty() && !conflicts.is_empty() {
        let names: Vec<String> = process_hits
            .iter()
            .filter_map(|c| c.get("label").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .collect();
        let pids: Vec<u64> = process_hits
            .iter()
            .flat_map(|c| {
                c.get("pids")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|v| v.as_u64())
            .collect();
        for c in conflicts.iter_mut() {
            if !names.is_empty() {
                let old = c.get("label").and_then(|v| v.as_str()).unwrap_or("");
                c["label"] = json!(format!("{}：{}", names.join("、"), old));
            }
            if !pids.is_empty() {
                c["pids"] = json!(pids);
            }
        }
    }
    let labels: Vec<String> = conflicts
        .iter()
        .map(|c| c.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string())
        .collect();
    json!({
        "conflicts": labels,
        "severity": if conflicts.is_empty() { "none" } else { "high" },
        "rawConflicts": conflicts,
    })
}

async fn resolve_external_proxy(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    let raw = sysproxy::query_raw();
    let active = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
        || raw
            .get("pacUrl")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
    if active {
        sysproxy::stop_pac_server(st);
        let (mixed, bypass) = {
            let i = st.inner.lock().await;
            (
                i.mixed_port,
                i.settings
                    .get("proxyBypass")
                    .and_then(|v| v.as_str())
                    .unwrap_or("localhost;127.*;10.*;192.168.*;<local>")
                    .to_string(),
            )
        };
        sysproxy::set("off", mixed, &bypass, 0)?;
        st.inner.lock().await.sys_proxy_on = false;
        let _ = app.emit("system:proxyChanged", json!({ "enabled": false }));
    }
    let procs = conflict::detect_processes(&st.inner.lock().await.own_core_pids);
    let pids: Vec<u32> = procs
        .iter()
        .flat_map(|p| {
            p.get("pids")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|v| v.as_u64().map(|n| n as u32))
        .collect();
    let result = conflict::kill_pids(&pids);
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    let check = check_conflicts_for_start(st).await;
    let remaining = check.get("conflicts").cloned().unwrap_or(json!([]));
    let mut out = result;
    out["ok"] = json!(remaining.as_array().map(|a| a.is_empty()).unwrap_or(true));
    out["conflicts"] = remaining;
    Ok(out)
}

async fn service_install(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    let (active, running, was_proxy) = {
        let i = st.inner.lock().await;
        (i.active_core.clone(), i.online || i.core.is_some(), i.sys_proxy_on)
    };
    let cfg_path = if active == "singbox" {
        st.paths.singbox_config.clone()
    } else {
        st.paths.runtime.clone()
    };
    if running {
        let _ = core::stop(app, st).await;
    }
    let install = backup::install_service(
        &st.paths.core_bin(&active),
        cfg_path.parent().unwrap_or(std::path::Path::new(".")),
        &cfg_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    if let Err(e) = install {
        let mut i = st.inner.lock().await;
        if let Some(o) = i.settings.as_object_mut() {
            o.insert("serviceMode".into(), json!(false));
        }
        let _ = state::save_settings(&st.paths.settings, &i.settings);
        drop(i);
        if running {
            let _ = core::start(app, st).await;
            if was_proxy {
                let _ = core::apply_proxy_mode(app, st, "system", false).await;
            }
        }
        crate::tray::notify(app, &format!("服务安装失败：{}", e));
        return Err(e);
    }
    {
        let mut i = st.inner.lock().await;
        if let Some(o) = i.settings.as_object_mut() {
            o.insert("serviceMode".into(), json!(true));
        }
        let _ = state::save_settings(&st.paths.settings, &i.settings);
    }
    if let Err(e) = core::start(app, st).await {
        let mut i = st.inner.lock().await;
        if let Some(o) = i.settings.as_object_mut() {
            o.insert("serviceMode".into(), json!(false));
        }
        let _ = state::save_settings(&st.paths.settings, &i.settings);
        drop(i);
        if running {
            let _ = core::start(app, st).await;
            if was_proxy {
                let _ = core::apply_proxy_mode(app, st, "system", false).await;
            }
        }
        return Err(format!("服务已安装但内核未接管：{}", e));
    }
    if was_proxy {
        let _ = core::apply_proxy_mode(app, st, "system", false).await;
    }
    Ok(json!({ "ok": true, "name": backup::SERVICE_NAME }))
}

async fn import_profile_url(app: &AppHandle, st: &AppState, payload: Value) -> Result<Value, String> {
    let fail = |msg: String| -> Result<Value, String> {
        let _ = app.emit(
            "core:progress",
            json!({"phase": "sub:download", "pct": 100, "label": ""}),
        );
        Err(msg)
    };
    let url = payload
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return fail("请输入有效的 http(s) 订阅链接".into());
    }
    let custom_name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let custom_name = if regex::Regex::new(r"(?i)^subscription\.ya?ml$")
        .unwrap()
        .is_match(&custom_name)
    {
        String::new()
    } else {
        custom_name
    };
    let (retries, timeout_sec, via_proxy, mixed, interval_min) = {
        let i = st.inner.lock().await;
        (
            i.settings.get("subRetry").and_then(|v| v.as_u64()).unwrap_or(3).max(1) as u32,
            i.settings.get("subTimeoutSec").and_then(|v| v.as_u64()).unwrap_or(30).max(5),
            i.settings.get("subUpdateViaProxy").and_then(|v| v.as_bool()).unwrap_or(true),
            i.mixed_port,
            i.settings.get("subAutoUpdateMin").and_then(|v| v.as_i64()).unwrap_or(0),
        )
    };
    let _ = app.emit(
        "core:progress",
        json!({"phase": "sub:download", "pct": 10, "label": "正在下载订阅…"}),
    );
    let mut raw: Option<Vec<u8>> = None;
    let mut headers = json!({});
    let mut last_err = String::from("内容为空");
    for i in 0..retries {
        match subscription::fetch_subscription(&url, mixed, via_proxy, timeout_sec).await {
            Ok((body, h)) => {
                if body.len() > 8 {
                    raw = Some(body);
                    headers = h;
                    break;
                }
                last_err = "订阅内容为空".into();
            }
            Err(e) => {
                last_err = e.clone();
                let backoff = if e.contains("429") {
                    5000 * (i as u64 + 1)
                } else {
                    600 * (i as u64 + 1)
                };
                tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
            }
        }
    }
    let Some(raw) = raw else {
        return fail(format!(
            "订阅拉取失败（重试 {} 次）：{}",
            retries, last_err
        ));
    };
    let _ = app.emit(
        "core:progress",
        json!({"phase": "sub:download", "pct": 60, "label": "订阅下载完成，正在解析…"}),
    );
    let content = subscription::normalize_subscription_body(&raw)?;
    if content.len() < 8 {
        return fail("订阅内容为空或无法解析".into());
    }
    let display_name = if !custom_name.is_empty() {
        custom_name.clone()
    } else {
        let from_header = subscription::name_from_headers(&headers);
        if from_header.is_empty() {
            util::subscription_display_name(&url)
        } else {
            from_header
        }
    };
    let result = core::apply_profile_content(app, st, &display_name, &content, "remote", Some(&url)).await?;
    if let Some(name) = result.get("name").and_then(|v| v.as_str()) {
        profiles::rename_by_url(&st.paths, &url, name, false);
    }
    let interval_hours = subscription::update_interval_hours(&headers);
    let interval_ms = if interval_hours > 0 {
        interval_hours * 3_600_000
    } else if interval_min > 0 {
        interval_min * 60_000
    } else {
        0
    };
    let userinfo = subscription::parse_userinfo(&headers);
    let entry = subscription::upsert_meta(
        &st.paths,
        &url,
        result
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&display_name),
        userinfo,
        if interval_ms > 0 {
            util::now_ms() + interval_ms
        } else {
            0
        },
    )?;
    let _ = app.emit(
        "core:progress",
        json!({"phase": "sub:download", "pct": 100, "label": format!("订阅「{}」已导入", entry.get("name").and_then(|v| v.as_str()).unwrap_or(""))}),
    );
    let mut out = result;
    out["bytes"] = json!(content.len());
    out["preview"] = json!(&content.chars().take(200).collect::<String>());
    out["nextUpdateAt"] = entry.get("nextUpdateAt").cloned().unwrap_or(json!(0));
    Ok(out)
}

async fn refresh_missing_subs(st: &AppState) -> Result<Value, String> {
    subscription::normalize_meta(&st.paths);
    let mut list = subscription::read_meta(&st.paths);
    let now = util::now_ms();
    let (via_proxy, mixed) = {
        let i = st.inner.lock().await;
        (
            i.settings.get("subUpdateViaProxy").and_then(|v| v.as_bool()).unwrap_or(true),
            i.mixed_port,
        )
    };
    let mut queue: Vec<usize> = Vec::new();
    for (idx, entry) in list.iter_mut().enumerate() {
        if !subscription::should_refresh_info(entry, now) {
            continue;
        }
        entry["metadataCheckedAt"] = json!(now);
        queue.push(idx);
    }
    let mut changed = !queue.is_empty();
    for chunk in queue.chunks(3) {
        let futures: Vec<_> = chunk
            .iter()
            .map(|&idx| {
                let url = list[idx]
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                async move {
                    let r = subscription::fetch_subscription(&url, mixed, via_proxy, 8).await;
                    (idx, r)
                }
            })
            .collect();
        for (idx, r) in futures_util::future::join_all(futures).await {
            let Ok((_, headers)) = r else { continue };
            let auto_named = {
                let entry = &list[idx];
                let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
                name == util::subscription_display_name(url)
            };
            let header_name = subscription::name_from_headers(&headers);
            if auto_named && !header_name.is_empty() {
                let old = list[idx].get("name").and_then(|v| v.as_str()).unwrap_or("");
                if header_name != old {
                    list[idx]["name"] = json!(header_name);
                    if let Some(url) = list[idx].get("url").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                        profiles::rename_by_url(&st.paths, &url, &header_name, true);
                    }
                    changed = true;
                }
            }
            if let Some(ui) = subscription::parse_userinfo(&headers) {
                list[idx]["userinfo"] = ui;
                changed = true;
            }
            let hours = subscription::update_interval_hours(&headers);
            if hours > 0 {
                list[idx]["nextUpdateAt"] = json!(util::now_ms() + hours * 3_600_000);
                changed = true;
            }
        }
    }
    if changed {
        let _ = subscription::write_meta(&st.paths, &list);
    }
    Ok(Value::Array(
        list.iter()
            .map(|e| {
                let mut v = e.clone();
                v["name"] = json!(subscription::pretty_name(e));
                v
            })
            .collect(),
    ))
}

#[allow(dead_code)]
fn _unused(_: &Paths, _: &singbox::ConvertResult) {}
