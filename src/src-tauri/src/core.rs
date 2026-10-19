//! 内核生命周期、运行时配置、代理模式（对齐 Electron main.cjs 核心链路）。
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::enhance::{self, EnhanceOpts};
use crate::profiles;
use crate::singbox;
use crate::state::{self, AppState, Inner, Paths};
use crate::sysproxy;
use crate::util;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn emit_status(app: &AppHandle, inner: &mut Inner, version: Option<Value>) {
    inner.seq += 1;
    let _ = app.emit(
        "core:status",
        json!({
            "running": inner.online,
            "seq": inner.seq,
            "version": version,
        }),
    );
}

pub fn set_online(app: &AppHandle, inner: &mut Inner, online: bool, version: Option<Value>) {
    inner.online = online;
    emit_status(app, inner, version);
}

/// 调用 mihomo/sing-box 控制接口；非 2xx 视为错误。
pub async fn api(
    controller: &str,
    secret: &str,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let (status, value) = api_status(controller, secret, path, method, body).await?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "HTTP {}: {}",
            status,
            value
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| value.to_string())
        ));
    }
    Ok(value)
}

pub async fn api_status(
    controller: &str,
    secret: &str,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://{}{}", controller, path);
    let mut req = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
            &url,
        )
        .header("Authorization", format!("Bearer {}", secret));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok((status, Value::Null));
    }
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok((status, value))
}

pub fn enhance_opts(inner: &Inner) -> EnhanceOpts {
    let s = &inner.settings;
    let ctrl_port = inner
        .controller
        .rsplit(':')
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(state::DEFAULT_CTRL);
    EnhanceOpts {
        mixed_port: inner.mixed_port,
        controller_port: ctrl_port,
        secret: inner.secret.clone(),
        allow_lan: s.get("allowLan").and_then(|v| v.as_bool()).unwrap_or(false),
        log_level: s
            .get("logLevel")
            .and_then(|v| v.as_str())
            .unwrap_or("info")
            .to_string(),
        bind_address: s
            .get("bindAddress")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1")
            .to_string(),
        dns_override: s.get("dnsOverride").and_then(|v| v.as_bool()).unwrap_or(false),
        dns_config: enhance::build_dns_config(s),
        tun_config: enhance::build_tun_config(s),
        unified_delay: s.get("unifiedDelay").and_then(|v| v.as_bool()).unwrap_or(true),
        tcp_concurrent: s
            .get("tcpConcurrent")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    }
}

/// 端口补丁：运行中热重载/首次启动都保证 runtime 端口与内存值一致。
pub fn patch_runtime_ports(paths: &Paths, inner: &Inner) -> Result<(), String> {
    let text = fs::read_to_string(&paths.runtime).map_err(|e| e.to_string())?;
    let ctrl_port = inner
        .controller
        .rsplit(':')
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(state::DEFAULT_CTRL);
    let allow_lan = inner
        .settings
        .get("allowLan")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let log_level = inner
        .settings
        .get("logLevel")
        .and_then(|v| v.as_str())
        .unwrap_or("info");
    let mut out = text;
    for (key, value) in [
        ("mixed-port", inner.mixed_port.to_string()),
        ("external-controller", format!("127.0.0.1:{}", ctrl_port)),
        ("secret", inner.secret.clone()),
        ("allow-lan", if allow_lan { "true" } else { "false" }.to_string()),
        ("log-level", log_level.to_string()),
    ] {
        out = patch_yaml_key(&out, key, &value);
    }
    util::atomic_write_text(&paths.runtime, &out)
}

fn patch_yaml_key(yaml: &str, key: &str, value: &str) -> String {
    let safe = if value
        .chars()
        .any(|c| matches!(c, ':' | '#' | '[' | ']' | '{' | '}' | '|' | '>' | '&' | '*' | '!' | '?' | ',' | '@' | '`'))
    {
        serde_json::to_string(value).unwrap_or_else(|_| format!("\"{}\"", value))
    } else {
        value.to_string()
    };
    let re = regex::Regex::new(&format!(r"(?m)^{}:\s*.+$", regex::escape(key))).unwrap();
    if re.is_match(yaml) {
        re.replace(yaml, format!("{}: {}", key, safe)).to_string()
    } else {
        format!("{}: {}\n{}", key, safe, yaml)
    }
}

pub async fn run_enhance_and_reload(
    app: &AppHandle,
    st: &AppState,
) -> Result<(String, Vec<String>, Vec<String>), String> {
    st.paths.ensure()?;
    profiles::migrate_legacy_files(&st.paths);
    let (text, warnings, logs) = {
        let inner = st.inner.lock().await;
        let opts = enhance_opts(&inner);
        enhance::enhance_and_write(&st.paths, &opts)?
    };
    reload_runtime_config(app, st).await;
    Ok((text, warnings, logs))
}

/// 增强写盘后：运行中热重载，失败则重启；未运行则保持停止。
pub async fn reload_runtime_config(app: &AppHandle, st: &AppState) {
    let (running, controller, secret, core, was_proxy) = {
        let i = st.inner.lock().await;
        (
            i.online || i.core.is_some(),
            i.controller.clone(),
            i.secret.clone(),
            i.active_core.clone(),
            i.sys_proxy_on,
        )
    };
    if !running {
        return;
    }
    if core == "singbox" {
        if let Err(e) = rebuild_singbox_config(app, st).await {
            let _ = app.emit("core:log", format!("[veyra] sing-box 重建失败：{}\n", e));
        }
        let _ = stop(app, st).await;
        let _ = start(app, st).await;
        if was_proxy {
            let _ = apply_proxy_mode(app, st, "system", false).await;
        }
        return;
    }
    match api(
        &controller,
        &secret,
        "/configs?force=true",
        "PUT",
        Some(json!({ "path": st.paths.runtime.to_string_lossy() })),
    )
    .await
    {
        Ok(_) => {
            let _ = app.emit("core:log", "[veyra] 配置已热重载\n");
        }
        Err(e) => {
            let _ = app.emit("core:log", format!("[veyra] 热重载失败（{}），重启内核…\n", e));
            let _ = stop(app, st).await;
            let _ = start(app, st).await;
            if was_proxy {
                let _ = apply_proxy_mode(app, st, "system", false).await;
            }
        }
    }
}

// ── sing-box 配置生成 ────────────────────────────────────
async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

async fn materialize_rule_sets(st: &AppState, config: &mut Value) -> Vec<String> {
    let mixed = st.inner.lock().await.mixed_port;
    let mut dropped = Vec::new();
    let Some(route) = config.get_mut("route") else {
        return dropped;
    };
    let sets = route
        .get("rule_set")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if sets.is_empty() {
        return dropped;
    }
    let _ = fs::create_dir_all(&st.paths.rulesets);
    let mut next = Vec::new();
    for s in sets {
        let Some(tag) = s.get("tag").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(url) = s.get("url").and_then(|v| v.as_str()) else {
            continue;
        };
        let safe: String = tag
            .chars()
            .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
            .collect();
        let dest = st.paths.rulesets.join(format!("{}.srs", safe));
        if !dest.exists() || fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == 0 {
            let mut got = None;
            if let Ok(client) = reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{}", mixed)).unwrap_or_else(|_| reqwest::Proxy::all("http://127.0.0.1:1").unwrap()))
                .build()
            {
                got = fetch_bytes(&client, url).await.ok();
            }
            if got.is_none() {
                if let Ok(client) = reqwest::Client::builder()
                    .timeout(Duration::from_secs(20))
                    .no_proxy()
                    .build()
                {
                    got = fetch_bytes(&client, url).await.ok();
                }
            }
            match got {
                Some(bytes) if !bytes.is_empty() => {
                    let _ = fs::write(&dest, bytes);
                }
                _ => {
                    dropped.push(tag.to_string());
                    continue;
                }
            }
        }
        next.push(json!({
            "type": "local", "tag": tag,
            "format": s.get("format").and_then(|v| v.as_str()).unwrap_or("binary"),
            "path": dest.to_string_lossy(),
        }));
    }
    route["rule_set"] = Value::Array(next);
    if !dropped.is_empty() {
        // 移除引用了被丢弃规则集的规则
        if let Some(rules) = route.get_mut("rules").and_then(|v| v.as_array_mut()) {
            rules.retain_mut(|r| {
                if let Some(arr) = r.get_mut("rule_set").and_then(|v| v.as_array_mut()) {
                    arr.retain(|t| {
                        t.as_str()
                            .map(|s| !dropped.iter().any(|d| d == s))
                            .unwrap_or(true)
                    });
                    if arr.is_empty() {
                        r.as_object_mut().map(|o| o.remove("rule_set"));
                    }
                }
                let meta = ["action", "outbound", "rule_set"];
                r.as_object()
                    .map(|o| o.keys().any(|k| !meta.contains(&k.as_str())))
                    .unwrap_or(true)
            });
        }
    }
    dropped
}

pub async fn rebuild_singbox_config(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    let _ = app.emit(
        "core:progress",
        json!({"phase": "singbox:build", "pct": 5, "label": "正在解析 Clash 订阅…"}),
    );
    st.paths.ensure()?;
    let text = util::read_text(&st.paths.runtime).unwrap_or_default();
    let clash: Value = serde_yaml::from_str(&text).unwrap_or_else(|_| json!({}));
    let (mixed, controller, secret, allow_lan, log_level, settings) = {
        let i = st.inner.lock().await;
        (
            i.mixed_port,
            i.controller.clone(),
            i.secret.clone(),
            i.settings.get("allowLan").and_then(|v| v.as_bool()).unwrap_or(false),
            i.settings.get("logLevel").and_then(|v| v.as_str()).unwrap_or("info").to_string(),
            i.settings.clone(),
        )
    };
    let ctrl_port = controller
        .rsplit(':')
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(19097);
    let _ = settings;
    let mut result = singbox::convert_clash_to_singbox(
        &clash,
        &json!({
            "mixedPort": mixed,
            "controllerHost": "127.0.0.1",
            "controllerPort": ctrl_port,
            "secret": secret,
            "allowLan": allow_lan,
            "logLevel": log_level,
        }),
    );
    let _ = app.emit(
        "core:progress",
        json!({"phase": "singbox:build", "pct": 55, "label": "正在下载 rule-set 文件…"}),
    );
    let dropped = materialize_rule_sets(st, &mut result.config).await;
    if !dropped.is_empty() {
        result
            .warnings
            .push(format!("以下规则集不可用已移除：{}", dropped.join("、")));
        result.stats["rules"] = json!(result
            .config
            .get("route")
            .and_then(|r| r.get("rules"))
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0));
    }
    let text = serde_json::to_string_pretty(&result.config).map_err(|e| e.to_string())?;
    util::atomic_write_text(&st.paths.singbox_config, &text)?;
    let _ = app.emit(
        "core:progress",
        json!({"phase": "singbox:build", "pct": 100, "label": "sing-box 配置已就绪"}),
    );
    let mut log = format!(
        "[veyra] sing-box 配置已生成：{} 节点 / {} 分组 / {} 规则\n",
        result.stats["nodes"], result.stats["groups"], result.stats["rules"]
    );
    for w in result.warnings.iter().take(12) {
        log.push_str(&format!("[veyra] sing-box: {}\n", w));
    }
    let _ = app.emit("core:log", log);
    Ok(result.stats)
}

// ── 启动 / 停止 ──────────────────────────────────────────
fn spawn_log_thread(app: &AppHandle, stdout: Option<std::process::ChildStdout>, stderr: Option<std::process::ChildStderr>) {
    if let Some(out) = stdout {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app.emit("core:log", format!("{}\n", line));
            }
        });
    }
    if let Some(err) = stderr {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app.emit("core:log", format!("{}\n", line));
            }
        });
    }
}

pub async fn start(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    let _guard = st.core_lock.lock().await;
    {
        let i = st.inner.lock().await;
        if i.online {
            return Ok(json!({ "already": true }));
        }
        if i.stopping {
            // 停止流程尚未完成：稍等后继续。
        }
    }
    st.paths.ensure()?;
    let (active_core, service_mode) = {
        let i = st.inner.lock().await;
        (
            i.active_core.clone(),
            i.settings.get("serviceMode").and_then(|v| v.as_bool()).unwrap_or(false),
        )
    };
    // 服务模式：内核由 VeyraCore 服务拉起，本进程只等待 controller 就绪后收养。
    if service_mode {
        let status = crate::backup::service_status();
        if status.get("installed").and_then(|v| v.as_bool()).unwrap_or(false) {
            if status.get("running").and_then(|v| v.as_bool()).unwrap_or(false) {
                let (controller, secret) = {
                    let i = st.inner.lock().await;
                    (i.controller.clone(), i.secret.clone())
                };
                for _ in 0..40 {
                    if let Ok(v) = api(&controller, &secret, "/version", "GET", None).await {
                        let mut i = st.inner.lock().await;
                        set_online(app, &mut i, true, Some(v.clone()));
                        return Ok(json!({ "version": v, "viaService": true }));
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                return Err("服务(VeyraCore)运行中但内核未响应，请在 设置 → 代理服务 里重启服务或改用本地模式".into());
            }
            return Err("服务(VeyraCore)已安装但未运行，请到设置里启动服务或改用本地模式".into());
        } else {
            let mut i = st.inner.lock().await;
            if let Some(o) = i.settings.as_object_mut() {
                o.insert("serviceMode".into(), json!(false));
            }
            let _ = state::save_settings(&st.paths.settings, &i.settings);
        }
    }

    // 已有 controller 响应（孤儿内核/外部内核）：收养，不重复 spawn。
    let (controller, secret) = {
        let i = st.inner.lock().await;
        (i.controller.clone(), i.secret.clone())
    };
    if let Ok(v) = api(&controller, &secret, "/version", "GET", None).await {
        let mut i = st.inner.lock().await;
        set_online(app, &mut i, true, Some(v.clone()));
        let _ = app.emit(
            "core:log",
            format!(
                "[veyra] controller {} 已有响应，收养为运行态（非本进程拉起，PID 未知）。如非 Veyra-omini 内核请更换控制端口。\n",
                controller
            ),
        );
        return Ok(json!({ "already": true, "version": v }));
    }
    if st.inner.lock().await.core.is_some() {
        return Ok(json!({ "already": true }));
    }

    // 端口：仅未运行时挑选，避免运行中把自身端口判为占用。
    let (mixed, controller, secret, allow_lan) = {
        let mut i = st.inner.lock().await;
        let prefer_mixed = i
            .settings
            .get("mixedPort")
            .and_then(|v| v.as_u64())
            .unwrap_or(state::DEFAULT_MIXED as u64) as u16;
        let prefer_ctrl = i
            .settings
            .get("controllerPort")
            .and_then(|v| v.as_u64())
            .unwrap_or(state::DEFAULT_CTRL as u64) as u16;
        let allow_lan = i.settings.get("allowLan").and_then(|v| v.as_bool()).unwrap_or(false);
        i.mixed_port = state::pick_port(prefer_mixed, allow_lan);
        let ctrl = state::pick_port(prefer_ctrl, allow_lan);
        i.controller = format!("127.0.0.1:{}", ctrl);
        (i.mixed_port, i.controller.clone(), i.secret.clone(), allow_lan)
    };
    let _ = allow_lan;

    // 运行时配置：有激活档案走增强，否则只补端口。
    let has_profile = profiles::active_uid(&st.paths).is_some();
    if active_core == "singbox" {
        if has_profile {
            let (text, warnings, logs) = {
                let i = st.inner.lock().await;
                let opts = enhance_opts(&i);
                enhance::enhance_and_write(&st.paths, &opts)?
            };
            let _ = (text, warnings, logs);
        } else {
            let i = st.inner.lock().await;
            patch_runtime_ports(&st.paths, &i)?;
        }
        rebuild_singbox_config(app, st).await?;
    } else if has_profile {
        let (text, warnings, logs) = {
            let i = st.inner.lock().await;
            let opts = enhance_opts(&i);
            enhance::enhance_and_write(&st.paths, &opts)?
        };
        let _ = (text, warnings, logs);
    } else {
        let i = st.inner.lock().await;
        patch_runtime_ports(&st.paths, &i)?;
    }

    let bin = st.paths.core_bin(&active_core);
    if !bin.exists() {
        return Err(format!(
            "内核({})未找到: {}，请到 设置 → 代理服务 里下载/切换内核",
            if active_core == "singbox" { "sing-box" } else { "Mihomo" },
            bin.display()
        ));
    }
    let core_args: Vec<String> = if active_core == "singbox" {
        vec![
            "run".into(),
            "-c".into(),
            st.paths.singbox_config.to_string_lossy().to_string(),
            "-D".into(),
            st.paths.config_dir.to_string_lossy().to_string(),
        ]
    } else {
        vec![
            "-d".into(),
            st.paths.config_dir.to_string_lossy().to_string(),
            "-f".into(),
            st.paths.runtime.to_string_lossy().to_string(),
        ]
    };
    let mut cmd = Command::new(&bin);
    cmd.args(&core_args)
        .current_dir(&st.paths.config_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "内核启动失败：{}（{}）",
            e,
            bin.display()
        )
    })?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    spawn_log_thread(app, stdout, stderr);
    {
        let mut i = st.inner.lock().await;
        i.core = Some(child);
        i.started_at = Some(util::now_ms());
        i.own_core_pids = vec![pid];
        i.stopping = false;
        i.core_gen += 1;
    }
    watch_exit(app.clone(), st.inner.lock().await.core_gen);

    // 等待 controller 就绪
    let mut version = Value::Null;
    let mut ready = false;
    for _ in 0..40 {
        if let Ok(v) = api(&controller, &secret, "/version", "GET", None).await {
            version = v;
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if !ready {
        let _ = stop(app, st).await;
        return Err("内核启动失败（端口可能被占用）。请检查设置中的端口后重试。".into());
    }
    {
        let mut i = st.inner.lock().await;
        set_online(app, &mut i, true, Some(version.clone()));
        i.auto_restarts = 0;
    }
    let settings = st.inner.lock().await.settings.clone();
    if settings
        .get("registerIdentity")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
    {
        let (mixed, ctrl, secret, mode) = {
            let i = st.inner.lock().await;
            (
                i.mixed_port,
                i.controller.clone(),
                i.secret.clone(),
                i.settings
                    .get("coreMode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("rule")
                    .to_string(),
            )
        };
        crate::conflict::register_self_identity(
            std::process::id(),
            mixed,
            &ctrl,
            &secret,
            &mode,
            env!("CARGO_PKG_VERSION"),
        );
        crate::conflict::start_monitor(app.clone(), 5000);
    }
    Ok(json!({ "version": version, "mixedPort": mixed, "controller": controller }))
}

fn watch_exit(app: AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let st = app.state::<AppState>();
            let exited = {
                let mut i = st.inner.lock().await;
                if i.core_gen != generation {
                    return;
                }
                if i.core.is_none() {
                    return;
                }
                match i.core.as_mut().and_then(|c| c.try_wait().ok()).flatten() {
                    Some(status) => {
                        i.core = None;
                        i.own_core_pids.clear();
                        i.online = false;
                        i.started_at = None;
                        Some(status.code().unwrap_or(-1))
                    }
                    None => None,
                }
            };
            let Some(code) = exited else { continue };
            {
                let mut i = st.inner.lock().await;
                emit_status(&app, &mut i, None);
                if i.stopping || i.quitting {
                    continue;
                }
                let should_restart = code != 0 && i.auto_restarts < 3;
                if should_restart {
                    i.auto_restarts += 1;
                    let n = i.auto_restarts;
                    drop(i);
                    let _ = app.emit(
                        "core:log",
                        format!("[veyra] 内核异常退出(code {})，自动重启（第 {}/3 次）…\n", code, n),
                    );
                    let a = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        let st = a.state::<AppState>();
                        if st.inner.lock().await.core.is_none() {
                            let _ = start(&a, &st).await;
                        }
                    });
                    continue;
                }
            }
            // 异常退出：清掉指向死端口的系统代理
            let _ = clear_our_system_proxy(&app, &st).await;
        }
    });
}

pub async fn stop(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    let _guard = st.core_lock.lock().await;
    stop_inner(app, st, true).await
}

async fn stop_inner(app: &AppHandle, st: &AppState, clear_proxy: bool) -> Result<Value, String> {
    if clear_proxy {
        let _ = clear_our_system_proxy(app, st).await;
    }
    let child = {
        let mut i = st.inner.lock().await;
        i.stopping = true;
        i.own_core_pids.clear();
        i.core.take()
    };
    if let Some(mut child) = child {
        let pid = child.id();
        #[cfg(windows)]
        {
            let _ = util::run("taskkill", &["/pid", &pid.to_string(), "/f", "/t"]);
        }
        let _ = child.kill();
        let _ = child.wait();
    } else {
        // 收养的内核：按 controller 端口定位占用者，确认是本应用 bin 目录才结束。
        let (controller, active) = {
            let i = st.inner.lock().await;
            (i.controller.clone(), i.active_core.clone())
        };
        if api(&controller, &st.inner.lock().await.secret, "/version", "GET", None)
            .await
            .is_ok()
        {
            if let Some(pid) = find_pid_listening_on(
                controller
                    .rsplit(':')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
            ) {
                let bin_dir = st.paths.core_bin(&active);
                let bin_dir = bin_dir.parent().unwrap_or(std::path::Path::new("."));
                if let Some(exe) = find_process_exe(pid) {
                    if exe
                        .to_string_lossy()
                        .to_lowercase()
                        .starts_with(&bin_dir.to_string_lossy().to_lowercase())
                    {
                        let _ = util::run("taskkill", &["/PID", &pid.to_string(), "/F", "/T"]);
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    let mut i = st.inner.lock().await;
    i.stopping = false;
    i.online = false;
    i.started_at = None;
    emit_status(app, &mut i, None);
    Ok(json!({ "running": false, "sysProxy": false }))
}

pub fn find_pid_listening_on(port: u16) -> Option<u32> {
    if port == 0 {
        return None;
    }
    let (out, _) = util::run("netstat", &["-ano"]).ok()?;
    let needle = format!(":{}", port);
    for line in out.lines() {
        if !line.to_lowercase().contains("listening") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        if cols[1].ends_with(&needle) {
            return cols.last().and_then(|p| p.parse().ok());
        }
    }
    None
}

pub fn find_process_exe(pid: u32) -> Option<std::path::PathBuf> {
    let script = format!(
        "(Get-CimInstance Win32_Process -Filter \"ProcessId={}\").ExecutablePath",
        pid
    );
    let out = util::powershell(&script).ok()?;
    let line = out.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(std::path::PathBuf::from(line))
    }
}

pub async fn restart(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    let was_proxy = st.inner.lock().await.sys_proxy_on;
    let _ = stop(app, st).await;
    let r = start(app, st).await?;
    if was_proxy {
        let _ = apply_proxy_mode(app, st, "system", false).await;
    }
    Ok(r)
}

pub async fn status(app: &AppHandle, st: &AppState) -> Value {
    let (controller, secret, core) = {
        let i = st.inner.lock().await;
        (i.controller.clone(), i.secret.clone(), i.core.is_some())
    };
    match api(&controller, &secret, "/version", "GET", None).await {
        Ok(v) => {
            let mut i = st.inner.lock().await;
            i.api_fail_streak = 0;
            if !i.online {
                set_online(app, &mut i, true, Some(v.clone()));
            }
            json!({
                "running": true,
                "version": v,
                "pid": i.core.as_ref().map(|c| c.id()),
                "seq": i.seq,
            })
        }
        Err(_) => {
            let mut i = st.inner.lock().await;
            i.api_fail_streak += 1;
            if i.online && i.api_fail_streak >= 3 {
                i.online = false;
                emit_status(app, &mut i, None);
            }
            json!({
                "running": i.online,
                "pid": i.core.as_ref().map(|c| c.id()),
                "seq": i.seq,
            })
        }
    }
}

pub async fn core_info(st: &AppState) -> Value {
    let (active, mixed, controller, secret, online, core_pid) = {
        let i = st.inner.lock().await;
        (
            i.active_core.clone(),
            i.mixed_port,
            i.controller.clone(),
            i.secret.clone(),
            i.online || i.core.is_some(),
            i.core.as_ref().map(|c| c.id()),
        )
    };
    let bin = st.paths.core_bin(&active);
    let size = fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
    let mtime = fs::metadata(&bin)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let file_version = core_version_of(&bin, &active);
    let build_asset = util::read_text(&st.paths.core_build_file(&active))
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let build = if active == "singbox" {
        if build_asset.is_empty() { "unknown" } else { "singbox" }
    } else if build_asset.to_lowercase().contains("compatible") {
        "compatible"
    } else if build_asset.is_empty() {
        "unknown"
    } else {
        "standard"
    };
    json!({
        "path": bin.to_string_lossy(),
        "exists": bin.exists(),
        "size": size,
        "mtime": mtime,
        "fileVersion": if file_version.is_empty() { Value::Null } else { json!(file_version) },
        "build": build,
        "buildAsset": build_asset,
        "cpu": std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default(),
        "cpuCount": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "arch": if std::env::consts::ARCH == "x86_64" { "x64" } else { std::env::consts::ARCH },
        "core": active,
        "pid": core_pid,
        "running": online,
        "mixedPort": mixed,
        "controller": controller,
        "secret": secret,
    })
}

fn core_version_of(bin: &std::path::Path, core: &str) -> String {
    if !bin.exists() {
        return String::new();
    }
    let args: &[&str] = if core == "singbox" { &["version"] } else { &["-v"] };
    let Ok((out, _)) = util::run(&bin.to_string_lossy(), args) else {
        return String::new();
    };
    let re = regex::Regex::new(r"(\d+\.\d+[.\d]*)").unwrap();
    if let Some(c) = re.captures(&out) {
        return c[1].to_string();
    }
    out.lines().next().unwrap_or("").trim().chars().take(64).collect()
}

pub async fn core_list(st: &AppState) -> Value {
    let mihomo = core_version_of(&st.paths.bin, "mihomo");
    let singbox = core_version_of(&st.paths.singbox_bin, "singbox");
    let active = st.inner.lock().await.active_core.clone();
    json!({
        "active": active,
        "mihomo": { "installed": st.paths.bin.exists(), "version": mihomo },
        "singbox": { "installed": st.paths.singbox_bin.exists(), "version": singbox },
    })
}

pub async fn switch_core(app: &AppHandle, st: &AppState, next: &str) -> Result<Value, String> {
    if next != "mihomo" && next != "singbox" {
        return Err(format!("未知内核：{}", next));
    }
    let (prev, running, was_proxy) = {
        let i = st.inner.lock().await;
        (i.active_core.clone(), i.online || i.core.is_some(), i.sys_proxy_on)
    };
    if next == prev {
        return Ok(json!({ "core": prev, "info": core_info(st).await }));
    }
    let label = if next == "singbox" { "sing-box" } else { "Mihomo" };
    let _ = stop(app, st).await;
    {
        let mut i = st.inner.lock().await;
        i.settings["core"] = json!(next);
        i.active_core = next.to_string();
        let _ = state::save_settings(&st.paths.settings, &i.settings);
    }
    let _ = app.emit("core:log", format!("[veyra] 切换内核 → {}\n", label));
    if !st.paths.core_bin(next).exists() {
        let _ = app.emit("core:log", format!("[veyra] 正在按需下载 {} 内核…\n", label));
        if let Err(e) = crate::update::update_core_binary(app, st, next).await {
            let mut i = st.inner.lock().await;
            i.settings["core"] = json!(prev);
            i.active_core = prev.clone();
            let _ = state::save_settings(&st.paths.settings, &i.settings);
            drop(i);
            if running {
                let _ = start(app, st).await;
                if was_proxy {
                    let _ = apply_proxy_mode(app, st, "system", false).await;
                }
            }
            return Err(format!(
                "{} 内核下载失败，已切回 {}：{}",
                label,
                if prev == "singbox" { "sing-box" } else { "Mihomo" },
                e
            ));
        }
    }
    if running {
        let _ = start(app, st).await;
        if was_proxy {
            let _ = apply_proxy_mode(app, st, "system", false).await;
        }
    }
    Ok(json!({ "core": next, "info": core_info(st).await }))
}

// ── 系统代理 ─────────────────────────────────────────────
pub async fn apply_proxy_mode(
    app: &AppHandle,
    st: &AppState,
    mode: &str,
    keep_intent: bool,
) -> Result<Value, String> {
    let (settings, mixed) = {
        let i = st.inner.lock().await;
        (i.settings.clone(), i.mixed_port)
    };
    let m = if mode.is_empty() {
        settings
            .get("proxyMode")
            .and_then(|v| v.as_str())
            .unwrap_or("system")
            .to_string()
    } else {
        mode.to_string()
    };
    if m != "off" {
        if let Some(external) = external_system_proxy_conflict(st).await {
            let label = external.get("label").and_then(|v| v.as_str()).unwrap_or("");
            let msg = format!(
                "检测到外部系统代理：{}。请先停止外部代理并退出对应软件后再启用 Veyra。",
                label
            );
            let data = json!({
                "conflicts": [label],
                "severity": "high",
                "rawConflicts": [external],
                "at": util::iso_now(),
            });
            {
                let mut i = st.inner.lock().await;
                i.startup_conflict = Some(data.clone());
            }
            let _ = app.emit("conflict:blockStartup", data);
            return Err(msg);
        }
    }
    let pac_port = if m == "pac" {
        sysproxy::start_pac_server(st, mixed).await?
    } else {
        sysproxy::stop_pac_server(st);
        0
    };
    let bypass = settings
        .get("proxyBypass")
        .and_then(|v| v.as_str())
        .unwrap_or("localhost;127.*;10.*;192.168.*;<local>")
        .to_string();
    let r = sysproxy::set(&m, mixed, &bypass, pac_port)?;
    {
        let mut i = st.inner.lock().await;
        i.sys_proxy_on = m != "off";
        if let Some(o) = i.settings.as_object_mut() {
            o.insert("proxyMode".into(), json!(m));
            o.insert("lastProxyOn".into(), json!(m != "off"));
            o.insert(
                "proxyPacUrl".into(),
                if m == "pac" {
                    r.get("pacUrl").cloned().unwrap_or(json!(""))
                } else {
                    json!("")
                },
            );
        }
        if !keep_intent {
            let _ = state::save_settings(&st.paths.settings, &i.settings);
        }
    }
    if m == "off" {
        let disconnect = st
            .inner
            .lock()
            .await
            .settings
            .get("disconnectOnProxyOff")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if disconnect {
            let (controller, secret) = {
                let i = st.inner.lock().await;
                (i.controller.clone(), i.secret.clone())
            };
            let _ = api(&controller, &secret, "/connections", "DELETE", None).await;
        }
    }
    let _ = app.emit("system:proxyChanged", json!({ "enabled": m != "off" }));
    Ok(r)
}

pub async fn set_system_proxy(app: &AppHandle, st: &AppState, enable: bool) -> Result<Value, String> {
    if !enable {
        return apply_proxy_mode(app, st, "off", false).await;
    }
    let mode = st
        .inner
        .lock()
        .await
        .settings
        .get("proxyMode")
        .and_then(|v| v.as_str())
        .unwrap_or("system")
        .to_string();
    let mode = if mode == "pac" { "pac" } else { "system" };
    apply_proxy_mode(app, st, mode, false).await
}

pub async fn external_system_proxy_conflict(st: &AppState) -> Option<Value> {
    let raw = sysproxy::query_raw();
    let enabled = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let server = raw.get("server").and_then(|v| v.as_str()).unwrap_or("");
    let pac = raw.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
    if !enabled && pac.is_empty() {
        return None;
    }
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
    let own_server = enabled && sysproxy::is_our_server(server, &ports);
    let own_pac = !pac.is_empty() && sysproxy::is_our_pac(pac, pac_port, &saved);
    if (!enabled || own_server) && (pac.is_empty() || own_pac) {
        return None;
    }
    Some(json!({
        "type": "system-proxy",
        "label": if !pac.is_empty() {
            format!("系统 PAC 代理被占用 → {}", pac)
        } else {
            format!("系统代理被占用 → {}", if server.is_empty() { "未知地址" } else { server })
        },
        "server": server,
        "pacUrl": pac,
    }))
}

pub async fn clear_our_system_proxy(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    let raw = sysproxy::query_raw();
    let enabled = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let server = raw.get("server").and_then(|v| v.as_str()).unwrap_or("");
    let pac = raw.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
    let (sys_on, mixed, prefer, pac_port, saved) = {
        let i = st.inner.lock().await;
        (
            i.sys_proxy_on,
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
    let ours = enabled && sysproxy::is_our_server(server, &ports);
    let our_pac = sys_on && !pac.is_empty() && sysproxy::is_our_pac(pac, pac_port, &saved);
    if ours || our_pac {
        return apply_proxy_mode(app, st, "off", true).await;
    }
    if sys_on {
        let mut i = st.inner.lock().await;
        i.sys_proxy_on = false;
        let _ = app.emit("system:proxyChanged", json!({ "enabled": false }));
    }
    Ok(json!({ "ok": true, "enabled": false, "skipped": true }))
}

pub async fn sync_system_proxy_state(app: &AppHandle, st: &AppState) -> Value {
    let st_json = sysproxy::status_async(st).await;
    let ours = st_json.get("ours").and_then(|v| v.as_bool()).unwrap_or(false);
    {
        let mut i = st.inner.lock().await;
        i.sys_proxy_on = ours;
    }
    let _ = app.emit("system:proxyChanged", json!({ "enabled": ours }));
    st_json
}

pub async fn set_core_mode(app: &AppHandle, st: &AppState, mode: &str) -> Result<Value, String> {
    let m = match mode {
        "global" => "global",
        "direct" => "direct",
        _ => "rule",
    };
    let (controller, secret) = {
        let i = st.inner.lock().await;
        (i.controller.clone(), i.secret.clone())
    };
    let r = api(
        &controller,
        &secret,
        "/configs",
        "PATCH",
        Some(json!({ "mode": m })),
    )
    .await?;
    {
        let mut i = st.inner.lock().await;
        if let Some(o) = i.settings.as_object_mut() {
            o.insert("coreMode".into(), json!(m));
        }
        let _ = state::save_settings(&st.paths.settings, &i.settings);
    }
    let _ = app.emit("core:status", json!({ "mode": m }));
    Ok(r)
}

// ── 代理守护 ─────────────────────────────────────────────
/// 每 4s 校准一次系统代理：内核在线且用户选择 system/pac 时，
/// 注册表被其它程序改掉就重新接管（与 Electron proxyGuard 语义一致）。
pub fn start_proxy_guard(app: &AppHandle, st: &AppState) {
    if let Ok(mut guard) = st.guard_task.lock() {
        if let Some(h) = guard.take() {
            h.abort();
        }
    }
    let enabled = match st.inner.try_lock() {
        Ok(i) => i
            .settings
            .get("proxyGuard")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        Err(_) => return,
    };
    if !enabled {
        return;
    }
    let app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(4000)).await;
            let st = app.state::<AppState>();
            let (guard_on, online, mode, pac) = {
                let i = st.inner.lock().await;
                (
                    i.settings.get("proxyGuard").and_then(|v| v.as_bool()).unwrap_or(false),
                    i.online,
                    i.settings
                        .get("proxyMode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("system")
                        .to_string(),
                    i.pac_port,
                )
            };
            if !guard_on {
                break;
            }
            if !online || mode == "off" {
                continue;
            }
            let raw = sysproxy::query_raw();
            let enabled = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let pac_url = raw.get("pacUrl").and_then(|v| v.as_str()).unwrap_or("");
            let (mixed, prefer, saved) = {
                let i = st.inner.lock().await;
                (
                    i.mixed_port,
                    i.settings
                        .get("mixedPort")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(state::DEFAULT_MIXED as u64) as u16,
                    i.settings
                        .get("proxyPacUrl")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            };
            let ports = sysproxy::proxy_ports(mixed, prefer);
            if mode == "pac" {
                if pac_url.is_empty() && !enabled {
                    let _ = apply_proxy_mode(&app, &st, "pac", true).await;
                }
            } else {
                if enabled && sysproxy::is_our_server(
                    raw.get("server").and_then(|v| v.as_str()).unwrap_or(""),
                    &ports,
                ) {
                    continue;
                }
                if !enabled && pac_url.is_empty() {
                    let _ = apply_proxy_mode(&app, &st, "system", true).await;
                } else if !pac_url.is_empty() && sysproxy::is_our_pac(pac_url, pac, &saved) {
                    let _ = apply_proxy_mode(&app, &st, "system", true).await;
                }
            }
        }
    });
    if let Ok(mut guard) = st.guard_task.lock() {
        *guard = Some(handle);
    }
}

// ── 档案导入 ─────────────────────────────────────────────
pub async fn apply_profile_content(
    app: &AppHandle,
    st: &AppState,
    name: &str,
    content: &str,
    kind: &str,
    url: Option<&str>,
) -> Result<Value, String> {
    st.paths.ensure()?;
    profiles::migrate_legacy_files(&st.paths);
    let item = if kind == "remote" {
        match url {
            Some(u) => match profiles::update_remote_by_url(&st.paths, u, content)? {
                Some(item) => item,
                None => profiles::import_local(&st.paths, name, content, kind, url)?,
            },
            None => profiles::import_local(&st.paths, name, content, kind, url)?,
        }
    } else {
        profiles::import_local(&st.paths, name, content, kind, url)?
    };
    let (_, warnings, script_logs) = run_enhance_and_reload(app, st).await?;
    let (mixed, controller) = {
        let i = st.inner.lock().await;
        (i.mixed_port, i.controller.clone())
    };
    Ok(json!({
        "ok": true,
        "path": profiles::item_path(&st.paths, &item).map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "uid": item.get("uid").cloned().unwrap_or(Value::Null),
        "name": item.get("name").cloned().unwrap_or(Value::Null),
        "mixedPort": mixed,
        "controller": controller,
        "warnings": warnings,
        "scriptLogs": script_logs,
    }))
}
