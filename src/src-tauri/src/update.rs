//! 应用更新与内核更新（对齐 Electron main.cjs update 链路）。
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{AppState, APP_UPDATE_REPO, DEFAULT_MIXED};
use crate::util;

// ── 版本比较 ─────────────────────────────────────────────
#[derive(Debug, PartialEq)]
pub struct Ver {
    major: u64,
    minor: u64,
    patch: u64,
    pre: String,
}

pub fn parse_version(v: &str) -> Option<Ver> {
    let s = v.trim().trim_start_matches(['v', 'V']);
    let re = regex::Regex::new(r"^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.]+))?$").unwrap();
    let c = re.captures(s)?;
    Some(Ver {
        major: c.get(1)?.as_str().parse().ok()?,
        minor: c.get(2)?.as_str().parse().ok()?,
        patch: c
            .get(3)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0),
        pre: c.get(4).map(|m| m.as_str().to_string()).unwrap_or_default(),
    })
}

fn compare_pre(a: &str, b: &str) -> i32 {
    // beta.10 > beta.9：按数字段比较。
    let split = |s: &str| -> Vec<String> { s.split('.').map(|x| x.to_string()).collect() };
    let (sa, sb) = (split(a), split(b));
    for i in 0..sa.len().max(sb.len()) {
        match (sa.get(i), sb.get(i)) {
            (None, None) => return 0,
            (None, Some(_)) => return -1,
            (Some(_), None) => return 1,
            (Some(x), Some(y)) => {
                let nx = x.parse::<i64>();
                let ny = y.parse::<i64>();
                let ord = match (nx, ny) {
                    (Ok(nx), Ok(ny)) => nx.cmp(&ny),
                    _ => x.cmp(y),
                };
                match ord {
                    std::cmp::Ordering::Less => return -1,
                    std::cmp::Ordering::Greater => return 1,
                    _ => {}
                }
            }
        }
    }
    0
}

/// 正数表示 a 比 b 新；正式版高于同号测试版。
pub fn compare_version(a: &str, b: &str) -> i32 {
    match (parse_version(a), parse_version(b)) {
        (Some(pa), Some(pb)) => {
            if pa.major != pb.major {
                return (pa.major as i64 - pb.major as i64) as i32;
            }
            if pa.minor != pb.minor {
                return (pa.minor as i64 - pb.minor as i64) as i32;
            }
            if pa.patch != pb.patch {
                return (pa.patch as i64 - pb.patch as i64) as i32;
            }
            if pa.pre == pb.pre {
                return 0;
            }
            if pa.pre.is_empty() {
                return 1;
            }
            if pb.pre.is_empty() {
                return -1;
            }
            compare_pre(&pa.pre, &pb.pre)
        }
        _ => compare_loose(a, b),
    }
}

fn compare_loose(a: &str, b: &str) -> i32 {
    let split = |s: &str| -> Vec<String> {
        s.trim_start_matches(['v', 'V'])
            .split(['.', '-', '+', '_'])
            .filter(|x| !x.is_empty())
            .map(|x| x.to_string())
            .collect()
    };
    let (sa, sb) = (split(a), split(b));
    for i in 0..sa.len().max(sb.len()) {
        match (sa.get(i), sb.get(i)) {
            (None, None) => return 0,
            (None, Some(_)) => return -1,
            (Some(_), None) => return 1,
            (Some(x), Some(y)) => {
                let ord = match (x.parse::<i64>(), y.parse::<i64>()) {
                    (Ok(nx), Ok(ny)) => nx.cmp(&ny),
                    _ => x.cmp(y),
                };
                match ord {
                    std::cmp::Ordering::Less => return -1,
                    std::cmp::Ordering::Greater => return 1,
                    _ => {}
                }
            }
        }
    }
    0
}

// ── 网络通道 ─────────────────────────────────────────────
pub fn parse_win_proxy_server(server: &str) -> Option<String> {
    let raw = server.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw
        .split(|c: char| c == ';' || c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect();
    let mut pick: Option<String> = None;
    for p in parts {
        let re = regex::Regex::new(r"(?i)^(?:(https?|socks5?)=)?([^=]+):(\d{2,5})$").unwrap();
        let Some(c) = re.captures(p) else { continue };
        let scheme = c.get(1).map(|m| m.as_str().to_string());
        let host = c.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        let port = c.get(3).map(|m| m.as_str()).unwrap_or("");
        if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
            continue;
        }
        if scheme.is_none() {
            return Some(format!("http://127.0.0.1:{}", port));
        }
        if pick.is_none() && matches!(scheme.as_deref(), Some("http") | Some("https")) {
            pick = Some(format!("http://127.0.0.1:{}", port));
        }
    }
    pick
}

fn is_our_loopback(proxy_url: &str, own: &[u16]) -> bool {
    let re = regex::Regex::new(r"(?i)(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)").unwrap();
    re.captures(proxy_url)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u16>().ok())
        .map(|p| own.contains(&p))
        .unwrap_or(false)
}

/// 候选出站通道：本地内核 → 外部回环系统代理 → 直连。
fn channels(st: &AppState, online: bool, mixed: u16) -> Vec<Option<String>> {
    let mut out = Vec::new();
    if online {
        out.push(Some(format!("http://127.0.0.1:{}", mixed)));
    }
    let raw = crate::sysproxy::query_raw();
    let server = raw.get("server").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(ext) = parse_win_proxy_server(server) {
        if !is_our_loopback(&ext, &[mixed, DEFAULT_MIXED]) {
            out.push(Some(ext));
        }
    }
    out.push(None);
    out
}

fn client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent("Veyra-omini");
    if let Some(p) = proxy {
        b = b.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
    } else {
        b = b.no_proxy();
    }
    b.build().map_err(|e| e.to_string())
}

/// 更新源仓库：默认用内置常量，可用 `VEYRA_UPDATE_REPO=owner/repo` 覆盖。
/// 私有仓库或自建镜像调试时不必改代码重打包，设环境变量即可。
fn update_repo() -> String {
    std::env::var("VEYRA_UPDATE_REPO")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| APP_UPDATE_REPO.to_string())
}

/// 私有仓库访问 GitHub API 需要 Token（`GITHUB_TOKEN` / `GH_TOKEN`）；公开仓库留空即可。
fn github_token() -> Option<String> {
    ["GITHUB_TOKEN", "GH_TOKEN"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|v| v.trim().to_string())
        .find(|v| !v.is_empty())
}

async fn fetch_json_with_channels(st: &AppState, url: &str) -> Result<Value, String> {
    let (online, mixed) = {
        let i = st.inner.lock().await;
        (i.online, i.mixed_port)
    };
    let token = github_token();
    let mut last = String::from("请求失败");
    for proxy in channels(st, online, mixed) {
        let c = client(proxy.as_deref())?;
        let mut req = c
            .get(url)
            .header("Accept", "application/vnd.github+json");
        if let Some(t) = &token {
            req = req.header("Authorization", format!("Bearer {}", t));
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return resp.json::<Value>().await.map_err(|e| e.to_string());
                }
                last = format!("HTTP {}", status.as_u16());
                if status.as_u16() == 404 {
                    break;
                }
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

// ── 应用更新 ─────────────────────────────────────────────
fn pick_setup_asset(assets: &[Value]) -> Option<Value> {
    let is_setup = |a: &Value| {
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let lower = name.to_lowercase();
        lower.ends_with(".exe") && lower.contains("setup") && lower.contains("x64")
    };
    let is_exe = |a: &Value| {
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        name.to_lowercase().ends_with(".exe") && !name.to_lowercase().contains("blockmap")
    };
    assets
        .iter()
        .find(|a| is_setup(a))
        .or_else(|| assets.iter().find(|a| is_exe(a)))
        .cloned()
}

pub async fn check_app_update(st: &AppState) -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let repo = update_repo();
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let data = match fetch_json_with_channels(st, &url).await {
        Ok(v) => v,
        Err(e) if e.contains("404") => {
            let list_url = format!("https://api.github.com/repos/{}/releases?per_page=10", repo);
            let list = match fetch_json_with_channels(st, &list_url).await {
                Ok(v) => v,
                // 仓库不存在 / 未公开时两个接口都是 404：这里给出能读懂的原因，
                // 而不是把原始状态码直接甩到界面上。
                Err(e2) if e2.contains("404") => {
                    return Err(format!(
                        "仓库 {} 没有可用的发布版本（HTTP 404，可能未发布或未公开）",
                        repo
                    ))
                }
                Err(e2) => return Err(e2),
            };
            list.as_array()
                .and_then(|a| a.iter().find(|r| !r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false)))
                .cloned()
                .ok_or_else(|| format!("仓库 {} 还没有任何发布版本", repo))?
        }
        Err(e) => return Err(e),
    };
    let tag = data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("GitHub 上还没有可安装的发布版本")?;
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let assets = data
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let asset = pick_setup_asset(&assets);
    // 解析 release 告示：既随接口返回（升级前就能看「更新内容」），
    // 也写进缓存（升级重启后 updateNotes 兜底再弹一次）
    let notes = parse_release_notes(
        data.get("body").and_then(|v| v.as_str()).unwrap_or(""),
        tag,
    );
    if let Some(entry) = &notes {
        let _ = util::write_json(&st.paths.update_notes_cache, entry);
    }
    Ok(json!({
        "current": current,
        "latest": latest,
        "notes": notes,
        "name": data.get("name").and_then(|v| v.as_str()).unwrap_or(tag),
        "htmlUrl": data.get("html_url").and_then(|v| v.as_str()).unwrap_or(""),
        "prerelease": data.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false),
        "hasUpdate": compare_version(&latest, &current) > 0,
        "assetName": asset.as_ref().and_then(|a| a.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
        "assetUrl": asset.as_ref().and_then(|a| a.get("browser_download_url")).and_then(|v| v.as_str()).unwrap_or(""),
        "assetSize": asset.as_ref().and_then(|a| a.get("size")).and_then(|v| v.as_u64()).unwrap_or(0),
        "assetDigest": asset.as_ref().and_then(|a| a.get("digest")).and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

fn emit_progress(app: &AppHandle, received: u64, total: u64, phase: &str) {
    let pct = if total > 0 {
        ((received * 100) / total).min(100)
    } else {
        0
    };
    let _ = app.emit(
        "app:updateProgress",
        json!({ "pct": pct, "received": received, "total": total, "phase": phase }),
    );
}

pub async fn download_app_update(app: &AppHandle, st: &AppState) -> Result<Value, String> {
    {
        let mut i = st.inner.lock().await;
        i.update_cancel = false;
    }
    let info = check_app_update(st).await?;
    if !info.get("hasUpdate").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(json!({ "started": false, "info": info }));
    }
    let asset_url = info
        .get("assetUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if asset_url.is_empty() {
        return Err("发布页没有 Windows 安装包".into());
    }
    let asset_name = info
        .get("assetName")
        .and_then(|v| v.as_str())
        .unwrap_or("Veyra-omini-Setup.exe")
        .to_string();
    let total = info.get("assetSize").and_then(|v| v.as_u64()).unwrap_or(0);
    let dest = std::env::temp_dir().join(&asset_name);
    let _ = fs::remove_file(&dest);
    let (online, mixed) = {
        let i = st.inner.lock().await;
        (i.online, i.mixed_port)
    };
    let mut last_err = String::from("下载失败");
    for proxy in channels(st, online, mixed) {
        if st.inner.lock().await.update_cancel {
            let _ = fs::remove_file(&dest);
            return Ok(json!({ "started": false, "cancelled": true, "info": info }));
        }
        let c = client(proxy.as_deref())?;
        emit_progress(app, 0, total, if proxy.is_some() { "proxy" } else { "direct" });
        let resp = match c
            .get(&asset_url)
            .header("Accept", "application/octet-stream")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        if !resp.status().is_success() {
            last_err = format!("HTTP {}", resp.status().as_u16());
            continue;
        }
        let resp_total = resp.content_length().unwrap_or(total);
        let mut file = match fs::File::create(&dest) {
            Ok(f) => f,
            Err(e) => return Err(e.to_string()),
        };
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut stream = resp.bytes_stream();
        let mut ok = true;
        while let Some(chunk) = stream.next().await {
            if st.inner.lock().await.update_cancel {
                ok = false;
                break;
            }
            match chunk {
                Ok(bytes) => {
                    if let Err(e) = file.write_all(&bytes) {
                        last_err = e.to_string();
                        ok = false;
                        break;
                    }
                    hasher.update(&bytes);
                    received += bytes.len() as u64;
                    emit_progress(app, received, resp_total, if proxy.is_some() { "proxy" } else { "direct" });
                }
                Err(e) => {
                    last_err = e.to_string();
                    ok = false;
                    break;
                }
            }
        }
        drop(file);
        if !ok {
            let _ = fs::remove_file(&dest);
            if st.inner.lock().await.update_cancel {
                return Ok(json!({ "started": false, "cancelled": true, "info": info }));
            }
            if proxy.is_some() {
                emit_progress(app, 0, total, "fallback");
            }
            continue;
        }
        let sha = hex::encode(hasher.finalize());
        let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        if size < 1024 {
            let _ = fs::remove_file(&dest);
            last_err = "安装包下载失败".into();
            continue;
        }
        if resp_total > 0 && size.abs_diff(resp_total) > 1024 {
            let _ = fs::remove_file(&dest);
            last_err = format!("安装包不完整（{} / {} 字节）", size, resp_total);
            continue;
        }
        let expected = info
            .get("assetDigest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_start_matches("sha256:")
            .to_lowercase();
        if !expected.is_empty() && sha != expected {
            let _ = fs::remove_file(&dest);
            return Err("安装包校验失败（SHA256 不匹配），已删除".into());
        }
        emit_progress(app, size, resp_total.max(size), "done");
        st.inner.lock().await.update_pending = Some(dest.clone());
        return Ok(json!({
            "started": false, "downloaded": true, "path": dest.to_string_lossy(),
            "sha256": sha, "info": info,
        }));
    }
    Err(format!(
        "{}。若代理已开启仍失败，请确认规则没有把 github.com 走直连（可临时切全局模式），或到发布页手动下载。",
        last_err
    ))
}

pub fn build_update_script(uninstaller: &str, installer: &str) -> String {
    let q = |p: &str| format!("\"{}\"", p.replace('"', "\"\"").replace('%', "%%"));
    [
        "@echo off".to_string(),
        "ping -n 3 127.0.0.1 >nul".to_string(),
        format!("{} /S", q(uninstaller)),
        "ping -n 6 127.0.0.1 >nul".to_string(),
        format!("start \"\" {}", q(installer)),
    ]
    .join("\r\n")
}

pub async fn install_app_update(app: &AppHandle, st: &AppState, mode: &str) -> Result<Value, String> {
    let installer = st
        .inner
        .lock()
        .await
        .update_pending
        .clone()
        .ok_or("安装包不存在或已被清理，请重新下载")?;
    if !installer.exists() {
        return Err("安装包不存在或已被清理，请重新下载".into());
    }
    if mode == "clean" {
        if !st.paths.is_packaged {
            return Err("开发模式无法卸载重装，请直接运行安装包".into());
        }
        let exe_dir = &st.paths.exe_dir;
        let uninstaller = fs::read_dir(exe_dir)
            .ok()
            .and_then(|rd| {
                rd.flatten().find_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if regex::Regex::new(r"(?i)^Uninstall .*\.exe$")
                        .unwrap()
                        .is_match(&n)
                    {
                        Some(e.path())
                    } else {
                        None
                    }
                })
            })
            .ok_or("找不到卸载程序，请手动卸载后运行安装包")?;
        let script = std::env::temp_dir().join(format!("veyra-update-{}.cmd", std::process::id()));
        fs::write(
            &script,
            format!(
                "{}\r\n",
                build_update_script(
                    &uninstaller.to_string_lossy(),
                    &installer.to_string_lossy()
                )
            ),
        )
        .map_err(|e| format!("无法写入更新脚本：{}", e))?;
        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.arg("/c").arg(&script);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x00000008 | 0x08000000); // DETACHED_PROCESS | CREATE_NO_WINDOW
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(400));
        app.exit(0);
        return Ok(json!({ "ok": true, "mode": "clean" }));
    }
    // 覆盖安装：启动 NSIS 安装包，然后退出当前进程。
    let mut cmd = std::process::Command::new(&installer);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(800));
    app.exit(0);
    Ok(json!({ "ok": true, "mode": "overwrite" }))
}

// ── release notes ───────────────────────────────────────
fn extract_list_items(text: &str) -> Vec<String> {
    let re = regex::Regex::new(r"(?m)^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$").unwrap();
    re.captures_iter(text)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// 极简 markdown 清理：链接只留标题、去掉粗体/行内代码标记，
/// 让「本次更新」里的条目是干净的纯文本，不会被 `**` 或 `[x](url)` 污染。
fn clean_md(line: &str) -> String {
    let link = regex::Regex::new(r"\[([^\]]*)\]\(([^)]*)\)").unwrap();
    let marks = regex::Regex::new(r"\*\*|__|`").unwrap();
    let s = link.replace_all(line, "$1").to_string();
    marks.replace_all(&s, "").trim().to_string()
}

pub fn parse_release_notes(body: &str, tag: &str) -> Option<Value> {
    let text = body.trim();
    if text.is_empty() {
        return None;
    }
    let title = clean_md(
        text.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim_start_matches('#')
            .trim(),
    );
    let date_re = regex::Regex::new(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})").unwrap();
    let date = date_re.captures(text).map(|c| {
        format!(
            "{}-{:02}-{:02}",
            &c[1],
            c[2].parse::<u32>().unwrap_or(1),
            c[3].parse::<u32>().unwrap_or(1)
        )
    });
    let list_start = regex::Regex::new(r"(?m)^\s*(?:[-*+]|\d+[.)])\s").unwrap();
    let list_text = list_start
        .find(text)
        .map(|m| &text[m.start()..])
        .unwrap_or("");
    // 没有 `- ` 列表时退回按行切：很多 Release 正文就是几行说明，
    // 只认列表会让「更新内容」弹窗整个空掉。
    let mut items: Vec<String> = if list_text.is_empty() {
        Vec::new()
    } else {
        extract_list_items(list_text)
    };
    if items.is_empty() {
        items = text
            .lines()
            .map(str::trim)
            .filter(|l| {
                !l.is_empty()
                    && !l.starts_with('#')
                    && !l.starts_with("```")
                    && !l.starts_with("![")
                    && !l.starts_with('<')
            })
            .take(12)
            .map(|l| clean_md(l.trim_start_matches(['-', '*', '+']).trim()))
            .filter(|l| !l.is_empty())
            .collect();
    } else {
        items = items.iter().map(|l| clean_md(l)).filter(|l| !l.is_empty()).collect();
    }
    if items.is_empty() {
        return None;
    }
    let channel = if regex::Regex::new(r"(?i)beta|alpha|rc|dev|test")
        .unwrap()
        .is_match(tag)
    {
        "beta"
    } else {
        "stable"
    };
    Some(json!({
        "version": tag.trim_start_matches(['v', 'V']),
        "date": date,
        "title": title,
        "channel": channel,
        "items": items,
    }))
}

// ── 内核更新 ─────────────────────────────────────────────
fn core_repo(core: &str) -> &'static str {
    if core == "singbox" {
        "SagerNet/sing-box"
    } else {
        "MetaCubeX/mihomo"
    }
}

pub async fn check_core_update(st: &AppState, core: &str) -> Result<Value, String> {
    let channel = {
        let i = st.inner.lock().await;
        i.settings
            .get("mihomoChannel")
            .and_then(|v| v.as_str())
            .unwrap_or("stable")
            .to_string()
    };
    let repo = core_repo(core);
    let url = if core != "singbox" && channel == "alpha" {
        format!("https://api.github.com/repos/{}/releases?per_page=15", repo)
    } else {
        format!("https://api.github.com/repos/{}/releases/latest", repo)
    };
    let mut data = fetch_json_with_channels(st, &url).await?;
    if let Some(arr) = data.as_array() {
        data = arr
            .iter()
            .find(|x| x.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false))
            .or_else(|| arr.first())
            .cloned()
            .unwrap_or_else(|| json!({}));
    }
    Ok(json!({
        "latest": data.get("tag_name").cloned().unwrap_or(Value::Null),
        "name": data.get("name").cloned().unwrap_or(Value::Null),
        "url": data.get("html_url").cloned().unwrap_or(Value::Null),
        "channel": if core == "mihomo" { channel } else { "stable".to_string() },
    }))
}

fn pick_core_asset(assets: &[Value], core: &str) -> Option<Value> {
    let find = |patterns: &[&str]| -> Option<Value> {
        assets.iter().find(|a| {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            name.ends_with(".zip") && patterns.iter().any(|p| name.contains(p))
        }).cloned()
    };
    if core == "singbox" {
        find(&["windows-amd64"])
    } else {
        // 标准版优先；CPU 缺少 AVX 时兼容版更稳，失败回退。
        find(&["windows-amd64-compatible"]).or_else(|| find(&["windows-amd64"]))
    }
}

async fn download_bytes(
    st: &AppState,
    url: &str,
    app: Option<&AppHandle>,
    phase: &str,
) -> Result<Vec<u8>, String> {
    let (online, mixed) = {
        let i = st.inner.lock().await;
        (i.online, i.mixed_port)
    };
    let mut last = String::from("下载失败");
    for proxy in channels(st, online, mixed) {
        let c = client(proxy.as_deref())?;
        match c.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let total = resp.content_length().unwrap_or(0);
                let mut buf = Vec::new();
                let mut stream = resp.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| e.to_string())?;
                    buf.extend_from_slice(&chunk);
                    if let Some(a) = app {
                        emit_progress(a, buf.len() as u64, total, phase);
                    }
                }
                return Ok(buf);
            }
            Ok(resp) => last = format!("HTTP {}", resp.status().as_u16()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

fn extract_bin_from_zip(bytes: &[u8], want: &str, dest: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("压缩包解析失败：{}", e))?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if name.eq_ignore_ascii_case(want) || name.ends_with(&format!("/{}", want)) {
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let tmp = dest.with_extension("download");
            let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
            out.sync_all().ok();
            fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err(format!("压缩包内未找到 {}", want))
}

pub async fn update_core_binary(
    app: &AppHandle,
    st: &AppState,
    core: &str,
) -> Result<Value, String> {
    let label = if core == "singbox" { "sing-box" } else { "Mihomo" };
    let (active, running, was_proxy) = {
        let i = st.inner.lock().await;
        (i.active_core.clone(), i.online || i.core.is_some(), i.sys_proxy_on)
    };
    let is_active = core == active;
    let was_running = is_active && running;
    if was_running {
        let _ = crate::core::stop(app, st).await;
    }
    let result = async {
        let url = if core == "singbox" {
            format!("https://api.github.com/repos/{}/releases/latest", core_repo(core))
        } else {
            let channel = {
                let i = st.inner.lock().await;
                i.settings
                    .get("mihomoChannel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stable")
                    .to_string()
            };
            if channel == "alpha" {
                format!("https://api.github.com/repos/{}/releases?per_page=15", core_repo(core))
            } else {
                format!("https://api.github.com/repos/{}/releases/latest", core_repo(core))
            }
        };
        let mut data = fetch_json_with_channels(st, &url).await?;
        if let Some(arr) = data.as_array() {
            data = arr
                .iter()
                .find(|x| x.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false))
                .or_else(|| arr.first())
                .cloned()
                .unwrap_or_else(|| json!({}));
        }
        let assets = data
            .get("assets")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let asset = pick_core_asset(&assets, core).ok_or_else(|| "发布页没有匹配的内核压缩包".to_string())?;
        let url = asset
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .ok_or("内核下载地址缺失")?;
        let asset_name = asset
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let bytes = download_bytes(st, url, Some(app), "core").await?;
        let bin = st.paths.core_bin(core);
        let want = if core == "singbox" {
            "sing-box.exe"
        } else {
            "mihomo.exe"
        };
        // 先备份旧二进制，失败可回滚。
        let bak = bin.with_extension("exe.bak");
        let had = bin.exists();
        if had {
            let _ = fs::copy(&bin, &bak);
        }
        if let Err(e) = extract_bin_from_zip(&bytes, want, &bin) {
            if had && !bin.exists() {
                let _ = fs::rename(&bak, &bin);
            }
            return Err(e);
        }
        let _ = fs::write(st.paths.core_build_file(core), format!("{}\n", asset_name));
        let _ = fs::remove_file(&bak);
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = result {
        if was_running {
            let _ = crate::core::start(app, st).await;
            if was_proxy {
                let _ = crate::core::apply_proxy_mode(app, st, "system", false).await;
            }
        }
        return Err(format!("{} 内核下载失败：{}", label, e));
    }
    if was_running {
        let _ = crate::core::start(app, st).await;
        if was_proxy {
            let _ = crate::core::apply_proxy_mode(app, st, "system", false).await;
        }
    }
    Ok(crate::core::core_info(st).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_order() {
        assert!(compare_version("1.1.9", "1.1.8") > 0);
        assert!(compare_version("1.10.0", "1.9.9") > 0);
        assert!(compare_version("2.0.0-beta.10", "2.0.0-beta.9") > 0);
        assert!(compare_version("1.0.0", "1.0.0-beta.1") > 0);
        assert_eq!(compare_version("v1.1.9", "1.1.9"), 0);
    }

    #[test]
    fn picks_setup() {
        let assets = vec![
            json!({"name": "x.blockmap"}),
            json!({"name": "Veyra-omini-Setup-1.1.9-x64.exe", "browser_download_url": "u"}),
        ];
        assert_eq!(pick_setup_asset(&assets).unwrap()["name"], "Veyra-omini-Setup-1.1.9-x64.exe");
    }

    #[test]
    fn parses_release_notes() {
        let body = "# v1.2.0\n\n2026-10-01\n\n- 修复 A\n- 新增 B\n";
        let v = parse_release_notes(body, "v1.2.0").unwrap();
        assert_eq!(v["version"], "1.2.0");
        assert_eq!(v["items"].as_array().unwrap().len(), 2);
    }
}
