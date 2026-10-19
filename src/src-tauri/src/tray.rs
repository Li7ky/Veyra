//! 系统托盘：状态、代理开关、模式、TUN、轻量模式、快速选节点（对齐 Electron updateTray）。
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{
    CheckMenuItem, IsMenuItem, MenuBuilder, MenuItem, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::core;
use crate::state::AppState;

static TRAY_READY: AtomicBool = AtomicBool::new(false);

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn tray_icon(app: &AppHandle, on: bool) -> Option<tauri::image::Image<'static>> {
    let st = app.state::<AppState>();
    let name = if on { "tray-win-on.png" } else { "tray-win-off.png" };
    let path = st.paths.resources.join("icons").join(name);
    if path.exists() {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(img) = tauri::image::Image::from_bytes(&bytes) {
                return Some(img.to_owned());
            }
        }
    }
    app.default_window_icon().cloned().map(|i| i.to_owned())
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Veyra-omini")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            handle_menu(app, &id);
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => show_main(tray.app_handle()),
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => show_main(tray.app_handle()),
                _ => {}
            }
        });
    if let Some(img) = tray_icon(app, false) {
        builder = builder.icon(img);
    }
    builder.build(app)?;
    TRAY_READY.store(true, Ordering::Relaxed);
    update_tray(app);
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    if let Some(node) = id.strip_prefix("node:") {
        let parts: Vec<&str> = node.split(':').collect();
        if parts.len() == 2 {
            let gi: usize = parts[0].parse().unwrap_or(0);
            let ni: usize = parts[1].parse().unwrap_or(0);
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let info = {
                    let g = st.tray_groups.lock().unwrap();
                    g.get(gi).and_then(|(name, nodes, _)| {
                        nodes.get(ni).map(|n| (name.clone(), n.clone()))
                    })
                };
                if let Some((group, name)) = info {
                    let (controller, secret) = {
                        let i = st.inner.lock().await;
                        (i.controller.clone(), i.secret.clone())
                    };
                    let path = format!("/proxies/{}", crate::util::percent_encode(&group));
                    let _ = core::api(
                        &controller,
                        &secret,
                        &path,
                        "PUT",
                        Some(json!({ "name": name })),
                    )
                    .await;
                    let _ = app.emit(
                        "veyra:notice",
                        json!({"message": format!("已切换 {} → {}", group, name), "at": crate::util::iso_now()}),
                    );
                }
            });
        }
        return;
    }
    match id {
        "show" => show_main(&app),
        "quit" => {
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let _ = core::set_system_proxy(&app, &st, false).await;
                let _ = core::stop(&app, &st).await;
                app.exit(0);
            });
        }
        "light" => {
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let on = !st
                    .inner
                    .lock()
                    .await
                    .settings
                    .get("lightweightMode")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                set_lightweight(&app, &st, on).await;
            });
        }
        "proxy" => {
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let sys_on = st.inner.lock().await.sys_proxy_on;
                if sys_on {
                    let _ = core::set_system_proxy(&app, &st, false).await;
                } else if !st.inner.lock().await.online {
                    notify(&app, "内核未运行，无法开启系统代理");
                } else {
                    let _ = core::set_system_proxy(&app, &st, true).await;
                }
                update_tray(&app);
            });
        }
        "sysproxy" => {
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let on = st.inner.lock().await.sys_proxy_on;
                if on {
                    let _ = core::set_system_proxy(&app, &st, false).await;
                } else {
                    {
                        let mut i = st.inner.lock().await;
                        if let Some(o) = i.settings.as_object_mut() {
                            o.insert("proxyMode".into(), json!("system"));
                        }
                        let _ = crate::state::save_settings(&st.paths.settings, &i.settings);
                    }
                    let _ = core::set_system_proxy(&app, &st, true).await;
                }
                update_tray(&app);
            });
        }
        "pac" => {
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let on = {
                    let i = st.inner.lock().await;
                    i.sys_proxy_on
                        && i.settings.get("proxyMode").and_then(|v| v.as_str()) == Some("pac")
                };
                if on {
                    let _ = core::apply_proxy_mode(&app, &st, "off", false).await;
                } else {
                    let _ = core::apply_proxy_mode(&app, &st, "pac", false).await;
                }
                update_tray(&app);
            });
        }
        "tun" => {
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let on = !st
                    .inner
                    .lock()
                    .await
                    .settings
                    .get("tunEnable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                {
                    let mut i = st.inner.lock().await;
                    if let Some(o) = i.settings.as_object_mut() {
                        o.insert("tunEnable".into(), json!(on));
                    }
                    let _ = crate::state::save_settings(&st.paths.settings, &i.settings);
                }
                let _ = core::run_enhance_and_reload(&app, &st).await;
                update_tray(&app);
            });
        }
        "mode-rule" | "mode-global" | "mode-direct" => {
            let mode = id.trim_start_matches("mode-").to_string();
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let _ = core::set_core_mode(&app, &st, &mode).await;
                update_tray(&app);
            });
        }
        "refresh-nodes" => {
            tauri::async_runtime::spawn(async move {
                refresh_nodes(&app).await;
                update_tray(&app);
            });
        }
        _ => {}
    }
}

pub async fn refresh_nodes(app: &AppHandle) {
    let st = app.state::<AppState>();
    let (controller, secret) = {
        let i = st.inner.lock().await;
        (i.controller.clone(), i.secret.clone())
    };
    if let Ok(v) = core::api(&controller, &secret, "/proxies", "GET", None).await {
        let mut groups = Vec::new();
        if let Some(map) = v.get("proxies").and_then(|p| p.as_object()) {
            for (name, g) in map {
                let ty = g.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if matches!(ty, "Selector" | "URLTest" | "Fallback" | "LoadBalance") {
                    let all: Vec<String> = g
                        .get("all")
                        .and_then(|a| a.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    let now = g
                        .get("now")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    groups.push((name.clone(), all, now));
                    if groups.len() >= 8 {
                        break;
                    }
                }
            }
        }
        if let Ok(mut cache) = st.tray_groups.lock() {
            *cache = groups;
        }
    }
}

pub fn update_tray(app: &AppHandle) {
    if !TRAY_READY.load(Ordering::Relaxed) {
        return;
    }
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    let st = app.state::<AppState>();
    let Ok(inner) = st.inner.try_lock() else {
        return;
    };
    let online = inner.online || inner.core.is_some();
    let sys_on = inner.sys_proxy_on;
    let settings = inner.settings.clone();
    let mixed = inner.mixed_port;
    let active_core = inner.active_core.clone();
    drop(inner);

    let proxy_active = online && sys_on;
    let core_label = if active_core == "singbox" { "sing-box" } else { "Mihomo" };
    let status = if proxy_active {
        "状态：代理生效中"
    } else if online {
        "状态：内核运行·代理关"
    } else {
        "状态：未连接"
    };
    let tip = if proxy_active {
        format!(
            "Veyra-omini · 代理生效中（绿点）\n{} · 127.0.0.1:{} · 系统代理：开",
            core_label, mixed
        )
    } else if online {
        format!(
            "Veyra-omini · 内核运行中，系统代理关（灰点）\n{} · 127.0.0.1:{} · 在窗口或托盘菜单打开系统代理",
            core_label, mixed
        )
    } else {
        format!("Veyra-omini · 未连接（灰点）\n当前内核：{}", core_label)
    };
    let _ = tray.set_tooltip(Some(&tip));
    if let Some(img) = tray_icon(app, proxy_active) {
        let _ = tray.set_icon(Some(img));
    }

    let build = || -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
        let status_item = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
        let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
        let light_on = settings
            .get("lightweightMode")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let light = CheckMenuItem::with_id(app, "light", "轻量模式", true, light_on, None::<&str>)?;
        let proxy_label = if sys_on { "关闭系统代理" } else { "开启系统代理" };
        let proxy = MenuItem::with_id(app, "proxy", proxy_label, online, None::<&str>)?;
        let sys = CheckMenuItem::with_id(
            app,
            "sysproxy",
            "系统代理",
            online,
            sys_on && settings.get("proxyMode").and_then(|v| v.as_str()) != Some("pac"),
            None::<&str>,
        )?;
        let pac = CheckMenuItem::with_id(
            app,
            "pac",
            "PAC 模式",
            online,
            sys_on && settings.get("proxyMode").and_then(|v| v.as_str()) == Some("pac"),
            None::<&str>,
        )?;
        let tun = CheckMenuItem::with_id(
            app,
            "tun",
            "TUN 模式",
            true,
            settings.get("tunEnable").and_then(|v| v.as_bool()).unwrap_or(false),
            None::<&str>,
        )?;
        let cur_mode = settings
            .get("coreMode")
            .and_then(|v| v.as_str())
            .unwrap_or("rule");
        let rule =
            CheckMenuItem::with_id(app, "mode-rule", "规则模式", true, cur_mode == "rule", None::<&str>)?;
        let global =
            CheckMenuItem::with_id(app, "mode-global", "全局模式", true, cur_mode == "global", None::<&str>)?;
        let direct =
            CheckMenuItem::with_id(app, "mode-direct", "直连模式", true, cur_mode == "direct", None::<&str>)?;
        let modes = SubmenuBuilder::new(app, "代理模式")
            .item(&rule)
            .item(&global)
            .item(&direct)
            .build()?;

        let groups = st.tray_groups.lock().map(|g| g.clone()).unwrap_or_default();
        let mut node_subs: Vec<tauri::menu::Submenu<tauri::Wry>> = Vec::new();
        for (gi, (gname, nodes, now)) in groups.iter().enumerate().take(8) {
            let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();
            for (ni, node) in nodes.iter().enumerate().take(40) {
                let label = if node == now {
                    format!("✓ {}", node)
                } else {
                    node.clone()
                };
                items.push(MenuItem::with_id(
                    app,
                    format!("node:{}:{}", gi, ni),
                    label,
                    true,
                    None::<&str>,
                )?);
            }
            if items.is_empty() {
                continue;
            }
            let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
                items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
            node_subs.push(SubmenuBuilder::new(app, gname).items(&refs).build()?);
        }
        let quick_label = if node_subs.is_empty() {
            "快速选节点（加载中…）"
        } else {
            "快速选节点"
        };
        let mut quick = SubmenuBuilder::new(app, quick_label);
        for sub in &node_subs {
            quick = quick.item(sub);
        }
        let refresh = MenuItem::with_id(app, "refresh-nodes", "刷新节点列表", online, None::<&str>)?;
        quick = quick.separator().item(&refresh);
        let quick = quick.build()?;

        let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        MenuBuilder::new(app)
            .item(&status_item)
            .separator()
            .item(&show)
            .item(&light)
            .item(&proxy)
            .item(&sys)
            .item(&pac)
            .item(&tun)
            .separator()
            .item(&modes)
            .item(&quick)
            .separator()
            .item(&quit)
            .build()
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
}

pub async fn set_lightweight(app: &AppHandle, st: &AppState, on: bool) {
    {
        let mut i = st.inner.lock().await;
        if let Some(o) = i.settings.as_object_mut() {
            o.insert("lightweightMode".into(), json!(on));
        }
        let _ = crate::state::save_settings(&st.paths.settings, &i.settings);
    }
    if let Some(w) = app.get_webview_window("main") {
        if on {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
    let _ = app.emit("app:lightweight", json!({ "on": on }));
    update_tray(app);
    notify(
        app,
        if on {
            "轻量模式：主窗口已收起，托盘继续工作"
        } else {
            "轻量模式已关闭"
        },
    );
}

pub fn notify(app: &AppHandle, message: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Veyra-omini")
        .body(message)
        .show();
}
