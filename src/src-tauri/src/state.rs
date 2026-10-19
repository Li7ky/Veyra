//! 应用运行时状态、路径与设置读写。
use serde_json::{json, Value};
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Child;

use crate::util;

pub const DEFAULT_SETTINGS: &str = include_str!("../defaults.json");
pub const DEFAULT_MIXED: u16 = 17897;
pub const DEFAULT_CTRL: u16 = 19097;
pub const APP_UPDATE_REPO: &str = "Li7ky/Veyra-omini";

#[derive(Clone)]
pub struct Paths {
    pub user_data: PathBuf,
    pub config_dir: PathBuf,
    pub profiles_dir: PathBuf,
    pub runtime: PathBuf,
    pub settings: PathBuf,
    pub subscriptions: PathBuf,
    pub resources: PathBuf,
    pub bin: PathBuf,
    pub singbox_bin: PathBuf,
    pub singbox_config: PathBuf,
    pub rulesets: PathBuf,
    pub backups: PathBuf,
    pub logs: PathBuf,
    pub update_notes_cache: PathBuf,
    pub exe_dir: PathBuf,
    pub is_packaged: bool,
}

impl Paths {
    pub fn new(resources: PathBuf) -> Self {
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
        let exe_dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let user_data = resolve_user_data(&exe_dir);
        let config_dir = user_data.join("config");
        let profiles_dir = config_dir.join("profiles");
        let resources_root = resources;
        let bin_name = if cfg!(windows) { "mihomo.exe" } else { "mihomo" };
        let sb_name = if cfg!(windows) { "sing-box.exe" } else { "sing-box" };
        Self {
            runtime: config_dir.join("config.yaml"),
            settings: user_data.join("settings.json"),
            subscriptions: config_dir.join("subscriptions.json"),
            singbox_config: config_dir.join("singbox.json"),
            rulesets: config_dir.join("rulesets"),
            backups: user_data.join("backups"),
            logs: user_data.join("logs"),
            update_notes_cache: user_data.join("update-notes-cache.json"),
            bin: resources_root.join("bin").join(bin_name),
            singbox_bin: resources_root.join("bin").join(sb_name),
            user_data,
            config_dir,
            profiles_dir,
            resources: resources_root,
            exe_dir,
            is_packaged: !cfg!(debug_assertions),
        }
    }

    pub fn ensure(&self) -> Result<(), String> {
        fs::create_dir_all(&self.profiles_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.backups).map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.logs).map_err(|e| e.to_string())?;
        if !self.runtime.exists() {
            let def = self.resources.join("config").join("default.yaml");
            if def.exists() {
                fs::copy(&def, &self.runtime).map_err(|e| e.to_string())?;
            } else {
                fs::write(&self.runtime, "mixed-port: 17897\nmode: rule\n")
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn core_bin(&self, core: &str) -> PathBuf {
        if core == "singbox" {
            self.singbox_bin.clone()
        } else {
            self.bin.clone()
        }
    }

    pub fn core_build_file(&self, core: &str) -> PathBuf {
        self.bin
            .parent()
            .unwrap_or(Path::new("."))
            .join(if core == "singbox" {
                "core-singbox.txt"
            } else {
                "core-mihomo.txt"
            })
    }
}

fn resolve_user_data(exe_dir: &Path) -> PathBuf {
    // 便携模式：exe 同级存在 portable.txt / portable 目录时使用 data 子目录。
    if exe_dir.join("portable.txt").exists() || exe_dir.join("portable").exists() {
        return exe_dir.join("data");
    }
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let primary = base.join("Veyra-omini");
    migrate_legacy_data(&base, &primary);
    primary
}

/// 品牌改名/早期版本的数据目录迁移：只有目标不存在 settings.json 时才复制。
fn migrate_legacy_data(app_data: &Path, dest: &Path) {
    if dest.join("settings.json").exists() {
        return;
    }
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for name in ["Veyra-Omni", "Veyra-Omini", "Crescent", "MoonCat", "mooncat", "aurora-proxy"] {
        let dir = app_data.join(name);
        if dir == dest {
            continue;
        }
        if let Ok(meta) = fs::metadata(dir.join("settings.json")) {
            if let Ok(mtime) = meta.modified() {
                candidates.push((mtime, dir));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let Some((_, src)) = candidates.into_iter().next() else {
        return;
    };
    if let Err(e) = copy_dir_all(&src, dest) {
        eprintln!("[veyra] 配置目录迁移失败: {}", e);
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

pub struct Inner {
    pub settings: Value,
    pub mixed_port: u16,
    pub controller: String,
    pub secret: String,
    pub core: Option<Child>,
    pub online: bool,
    pub sys_proxy_on: bool,
    pub seq: u64,
    pub started_at: Option<i64>,
    pub active_core: String,
    pub api_fail_streak: u32,
    pub auto_restarts: u32,
    pub conflict_stopped: bool,
    pub own_core_pids: Vec<u32>,
    pub pac_port: u16,
    pub update_pending: Option<PathBuf>,
    pub update_cancel: bool,
    pub startup_conflict: Option<Value>,
    pub stopping: bool,
    pub quitting: bool,
    pub core_gen: u64,
}

pub struct DragState {
    pub start_x: f64,
    pub start_y: f64,
    pub win_x: i32,
    pub win_y: i32,
}

pub struct AppState {
    pub inner: tokio::sync::Mutex<Inner>,
    pub drag: std::sync::Mutex<Option<DragState>>,
    pub paths: Paths,
    pub core_lock: tokio::sync::Mutex<()>,
    pub guard_task: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub monitor_task: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub pac_task: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// 托盘「快速选节点」缓存：(分组名, 节点名列表, 当前节点)
    pub tray_groups: std::sync::Mutex<Vec<(String, Vec<String>, String)>>,
}

impl AppState {
    pub fn new(paths: Paths) -> Self {
        let settings = load_settings(&paths.settings);
        let mixed_port = settings
            .get("mixedPort")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_MIXED as u64) as u16;
        let ctrl = settings
            .get("controllerPort")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_CTRL as u64) as u16;
        let secret = settings
            .get("secret")
            .and_then(|v| v.as_str())
            .unwrap_or("veyra-secret")
            .to_string();
        let active_core = if settings.get("core").and_then(|v| v.as_str()) == Some("singbox") {
            "singbox".to_string()
        } else {
            "mihomo".to_string()
        };
        Self {
            inner: tokio::sync::Mutex::new(Inner {
                settings,
                mixed_port,
                controller: format!("127.0.0.1:{}", ctrl),
                secret,
                core: None,
                online: false,
                sys_proxy_on: false,
                seq: 0,
                started_at: None,
                active_core,
                api_fail_streak: 0,
                auto_restarts: 0,
                conflict_stopped: false,
                own_core_pids: Vec::new(),
                pac_port: 0,
                update_pending: None,
                update_cancel: false,
                startup_conflict: None,
                stopping: false,
                quitting: false,
                core_gen: 0,
            }),
            drag: std::sync::Mutex::new(None),
            paths,
            core_lock: tokio::sync::Mutex::new(()),
            guard_task: std::sync::Mutex::new(None),
            monitor_task: std::sync::Mutex::new(None),
            pac_task: std::sync::Mutex::new(None),
            tray_groups: std::sync::Mutex::new(Vec::new()),
        }
    }
}

pub fn defaults() -> Value {
    serde_json::from_str(DEFAULT_SETTINGS).unwrap_or_else(|_| json!({}))
}

pub fn load_settings(path: &Path) -> Value {
    let mut out = defaults();
    if let Some(v) = util::read_json(path) {
        if let (Some(dst), Some(src)) = (out.as_object_mut(), v.as_object()) {
            for (k, val) in src {
                dst.insert(k.clone(), val.clone());
            }
        }
    }
    out
}

pub fn save_settings(path: &Path, settings: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    util::atomic_write_text(path, &text)
}

pub fn merge_patch(base: &mut Value, patch: &Value) {
    if let (Some(dst), Some(src)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
}

/// 端口是否可用：与 Electron 版一致，先探 127.0.0.1；allowLan 时再探 0.0.0.0。
pub fn port_usable(port: u16, allow_lan: bool) -> bool {
    if TcpListener::bind(("127.0.0.1", port)).is_err() {
        return false;
    }
    if allow_lan && TcpListener::bind(("0.0.0.0", port)).is_err() {
        return false;
    }
    true
}

pub fn pick_port(prefer: u16, allow_lan: bool) -> u16 {
    if port_usable(prefer, allow_lan) {
        return prefer;
    }
    let alt = prefer.saturating_add(10003);
    if port_usable(alt, allow_lan) {
        return alt;
    }
    prefer
}

pub fn now_ms() -> i64 {
    util::now_ms()
}
