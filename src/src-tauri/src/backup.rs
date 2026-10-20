//! 备份/WebDAV/UWP/服务模式等系统集成（对齐 Electron verge-ext + win-service）。
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::state::Paths;
use crate::util;

// ── 备份 ─────────────────────────────────────────────────
fn collect_files(root: &Path, base: &str, out: &mut Vec<(String, Vec<u8>)>) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if base.is_empty() {
                name
            } else {
                format!("{}/{}", base, name)
            };
            collect_files(&path, &rel, out);
        } else if let Ok(data) = fs::read(&path) {
            let name = entry.file_name().to_string_lossy().replace('\\', "/");
            let rel = if base.is_empty() {
                name
            } else {
                format!("{}/{}", base, name)
            };
            out.push((rel, data));
        }
    }
}

pub fn export_backup_zip(paths: &Paths) -> Result<Value, String> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    if let Ok(data) = fs::read(&paths.settings) {
        files.push(("settings.json".into(), data));
    }
    collect_files(&paths.config_dir, "config", &mut files);
    fs::create_dir_all(&paths.backups).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S%.3f");
    let out_path = paths.backups.join(format!("veyra-backup-{}.zip", stamp));
    let file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in &files {
        zip.start_file(name.clone(), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(data).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    let bytes = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "ok": true,
        "path": out_path.to_string_lossy(),
        "bytes": bytes,
        "count": files.len(),
    }))
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

pub fn import_backup_zip(zip_path: &Path, paths: &Paths) -> Result<Value, String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let tmp = paths.user_data.join("backup-import-tmp");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("压缩包含非法路径条目：{}", entry.name()));
        };
        let rel = rel.to_path_buf();
        let is_dir = entry.name().ends_with('/');
        let target = tmp.join(&rel);
        if is_dir {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if !target.starts_with(&tmp) {
                return Err(format!("压缩包条目路径逃逸：{}", entry.name()));
            }
            if let Some(dir) = target.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
            fs::write(&target, data).map_err(|e| e.to_string())?;
        }
        names.push(rel.to_string_lossy().replace('\\', "/"));
    }
    let settings_src = tmp.join("settings.json");
    if settings_src.exists() {
        fs::copy(&settings_src, &paths.settings).map_err(|e| e.to_string())?;
    }
    let config_src = tmp.join("config");
    if config_src.exists() {
        let stage = paths.user_data.join("backup-import-stage");
        let _ = fs::remove_dir_all(&stage);
        fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
        let stage_result = (|| -> Result<(), String> {
            copy_dir_all(&config_src, &stage).map_err(|e| e.to_string())?;
            let empty = fs::read_dir(&stage)
                .map(|mut rd| rd.next().is_none())
                .unwrap_or(true);
            if empty {
                return Err("备份包中的 config 目录为空，已保留现有数据".into());
            }
            Ok(())
        })();
        if let Err(e) = stage_result {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("备份导入失败（已保留原有数据）：{}", e));
        }
        let prev = paths.user_data.join("backup-import-prev");
        let _ = fs::remove_dir_all(&prev);
        if paths.config_dir.exists() {
            fs::rename(&paths.config_dir, &prev).map_err(|e| e.to_string())?;
        }
        if let Err(e) = fs::rename(&stage, &paths.config_dir) {
            let _ = fs::remove_dir_all(&paths.config_dir);
            if prev.exists() {
                let _ = fs::rename(&prev, &paths.config_dir);
            }
            return Err(format!("备份导入失败（已还原原有数据）：{}", e));
        }
        let _ = fs::remove_dir_all(&prev);
    }
    let _ = fs::remove_dir_all(&tmp);
    Ok(json!({ "ok": true, "files": names }))
}

// ── WebDAV ───────────────────────────────────────────────
pub fn obscure_secret(text: &str) -> String {
    let key = b"veyra-webdav";
    let mut buf = text.as_bytes().to_vec();
    for (i, b) in buf.iter_mut().enumerate() {
        *b ^= key[i % key.len()];
    }
    format!("enc:{}", util::b64_encode(&buf))
}

pub fn reveal_secret(text: &str) -> String {
    let Some(rest) = text.strip_prefix("enc:") else {
        return text.to_string();
    };
    let Some(mut buf) = util::b64_decode_flexible(rest) else {
        return String::new();
    };
    let key = b"veyra-webdav";
    for (i, b) in buf.iter_mut().enumerate() {
        *b ^= key[i % key.len()];
    }
    String::from_utf8_lossy(&buf).to_string()
}

fn webdav_client(user: &str, pass: &str) -> Result<reqwest::Client, String> {
    let auth = format!(
        "Basic {}",
        util::b64_encode(format!("{}:{}", user, pass).as_bytes())
    );
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        reqwest::header::HeaderValue::from_str(&auth).map_err(|e| e.to_string())?,
    );
    reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("Veyra-WebDAV/1.0")
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

fn webdav_url(base: &str, remote: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        remote.trim_start_matches('/')
    )
}

pub async fn webdav_put(
    url: &str,
    user: &str,
    pass: &str,
    body: Vec<u8>,
    remote: &str,
) -> Result<Value, String> {
    if url.trim().is_empty() {
        return Err("未配置 WebDAV 地址".into());
    }
    let target = webdav_url(url, remote);
    let client = webdav_client(user, pass)?;
    let mut last = String::from("WebDAV 上传失败");
    for i in 0..3 {
        match client
            .put(&target)
            .header("Content-Type", "application/zip")
            .body(body.clone())
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                return Ok(json!({ "ok": true, "status": r.status().as_u16(), "url": target }));
            }
            Ok(r) => last = format!("WebDAV PUT 失败 HTTP {}", r.status().as_u16()),
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(500 * (i + 1))).await;
    }
    Err(last)
}

pub async fn webdav_get(
    url: &str,
    user: &str,
    pass: &str,
    remote: &str,
) -> Result<Vec<u8>, String> {
    if url.trim().is_empty() {
        return Err("未配置 WebDAV 地址".into());
    }
    let target = webdav_url(url, remote);
    let client = webdav_client(user, pass)?;
    let mut last = String::from("WebDAV 下载失败");
    for i in 0..3 {
        match client.get(&target).send().await {
            Ok(r) if r.status().is_success() => {
                return r.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string());
            }
            Ok(r) => last = format!("WebDAV GET 失败 HTTP {}", r.status().as_u16()),
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(500 * (i + 1))).await;
    }
    Err(last)
}

// ── 服务模式 ─────────────────────────────────────────────
pub const SERVICE_NAME: &str = "VeyraCore";

pub fn service_status() -> Value {
    match util::run("sc.exe", &["query", SERVICE_NAME]) {
        Ok((stdout, _)) => {
            let installed = stdout.to_uppercase().contains("SERVICE_NAME");
            let running = stdout.to_uppercase().contains("RUNNING");
            json!({ "installed": installed, "running": running })
        }
        Err(_) => json!({ "installed": false, "running": false }),
    }
}

pub fn install_service(bin: &Path, work_dir: &Path, config_file: &str) -> Result<Value, String> {
    if !bin.exists() {
        return Err("内核不存在".into());
    }
    let bin = bin.to_string_lossy().replace('"', "");
    let wd = work_dir.to_string_lossy().replace('"', "");
    let cfg = config_file.replace('"', "");
    let bin_path_arg = format!("\\\"{}\\\" -d \\\"{}\\\" -f \\\"{}\\\"", bin, wd, cfg);
    let wd_sql = wd.replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$svc = Get-Service -Name '{name}' -ErrorAction SilentlyContinue
if ($svc) {{
  Stop-Service '{name}' -Force -ErrorAction SilentlyContinue
  sc.exe delete {name} | Out-Null
  Start-Sleep -Seconds 1
}}
New-Item -ItemType Directory -Force -Path '{wd}' | Out-Null
sc.exe create {name} binPath= "{binpath}" start= auto DisplayName= "Veyra Core Service"
if ($LASTEXITCODE -ne 0) {{ throw "sc.exe create 失败（退出码 $LASTEXITCODE），常见原因：权限不足或路径含特殊字符" }}
sc.exe description {name} "Veyra mihomo/sing-box elevated service for TUN" | Out-Null
Start-Service {name} -ErrorAction Stop
Start-Sleep -Milliseconds 500
if ((Get-Service -Name '{name}').Status -ne 'Running') {{ throw "服务已创建但未进入 Running 状态" }}
'OK'
"#,
        name = SERVICE_NAME,
        wd = wd_sql,
        binpath = bin_path_arg
    );
    util::powershell_elevated(&script).map_err(|e| format!("服务安装失败：{}", e))?;
    Ok(json!({ "ok": true, "name": SERVICE_NAME }))
}

pub fn uninstall_service() -> Value {
    let script = format!(
        r#"
$svc = Get-Service -Name '{name}' -ErrorAction SilentlyContinue
if ($svc) {{
  Stop-Service '{name}' -Force -ErrorAction SilentlyContinue
  sc.exe delete {name} | Out-Null
}}
'OK'
"#,
        name = SERVICE_NAME
    );
    match util::powershell_elevated(&script) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": format!("服务卸载失败：{}", e) }),
    }
}

// ── UWP 回环 ─────────────────────────────────────────────
pub fn enable_uwp_loopback() -> Result<Value, String> {
    let script = r#"
Get-AppxPackage | ForEach-Object {
  CheckNetIsolation.exe LoopbackExempt -a -n="$($_.PackageFamilyName)" 2>$null | Out-Null
}
'ok'
"#;
    util::powershell(script).map(|_| json!({ "ok": true }))
}

// ── 杂项 ─────────────────────────────────────────────────
pub fn validate_dns(ns: &str) -> Value {
    let ns = ns.trim();
    if ns.is_empty() {
        return json!({ "ok": false, "error": "空 nameserver" });
    }
    let re = regex::Regex::new(r"(?i)^(?:tls://|https://|quic://|dhcp://)?([^:#/\s]+)").unwrap();
    match re.captures(ns) {
        Some(c) => json!({ "ok": true, "host": c.get(1).map(|m| m.as_str()).unwrap_or("") }),
        None => json!({ "ok": false, "error": "格式无效" }),
    }
}

pub fn proxy_env_text(port: u16) -> String {
    let p = format!("http://127.0.0.1:{}", port);
    [
        format!("set HTTP_PROXY={}", p),
        format!("set HTTPS_PROXY={}", p),
        format!("set ALL_PROXY={}", p),
        "# bash/zsh:".into(),
        format!("export http_proxy={}", p),
        format!("export https_proxy={}", p),
        format!("export all_proxy={}", p),
    ]
    .join("\n")
}

pub fn vc_runtime() -> Value {
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let dll = PathBuf::from(sys).join("System32").join("vcruntime140.dll");
    let installed = dll.exists();
    json!({
        "ok": installed,
        "installed": installed,
        "downloadUrl": "https://aka.ms/vs/17/release/vc_redist.x64.exe",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_roundtrip() {
        let enc = obscure_secret("p@ss:中文");
        assert!(enc.starts_with("enc:"));
        assert_eq!(reveal_secret(&enc), "p@ss:中文");
        assert_eq!(reveal_secret("plain"), "plain");
    }

    #[test]
    fn dns_validation() {
        assert_eq!(validate_dns("tls://dns.alidns.com")["ok"], true);
        assert_eq!(validate_dns("")["ok"], false);
    }

    #[test]
    fn webdav_url_join() {
        assert_eq!(
            webdav_url("https://dav.example.com/remote", "a.zip"),
            "https://dav.example.com/remote/a.zip"
        );
    }
}
