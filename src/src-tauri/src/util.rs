//! 通用工具：原子写、子进程、编码、时间、名称清洗。
use base64::Engine;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn iso_now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 原子写：同目录临时文件 + rename，避免写一半被杀留下半截文件。
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".into());
    // 临时文件名带自增序号：同一进程内并发写同一目标时不能共用一个 tmp。
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{}.tmp-{}-{}", name, std::process::id(), seq));
    let result = (|| -> Result<(), String> {
        fs::write(&tmp, data).map_err(|e| e.to_string())?;
        if let Err(first) = fs::rename(&tmp, path) {
            // Windows 下目标被占用时 rename 会失败：把旧文件挪到旁路再试；
            // 二次仍失败则把旧文件放回原位——绝不先删目标，避免文件整个丢失。
            let backup = path.with_file_name(format!(
                ".{}.old-{}-{}",
                name,
                std::process::id(),
                seq
            ));
            if fs::rename(path, &backup).is_ok() {
                match fs::rename(&tmp, path) {
                    Ok(()) => {
                        let _ = fs::remove_file(&backup);
                    }
                    Err(e) => {
                        let _ = fs::rename(&backup, path);
                        let _ = fs::remove_file(&tmp);
                        return Err(e.to_string());
                    }
                }
            } else {
                let _ = fs::remove_file(&tmp);
                return Err(first.to_string());
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
use std::sync::atomic::Ordering;

pub fn atomic_write_text(path: &Path, text: &str) -> Result<(), String> {
    atomic_write(path, text.as_bytes())
}

pub fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
}

pub fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    atomic_write_text(path, &text)
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// 执行外部命令并返回 (stdout, stderr)。失败时返回 Err(stderr/错误)。
pub fn run(cmd: &str, args: &[&str]) -> Result<(String, String), String> {
    let mut c = Command::new(cmd);
    c.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut c);
    let out = c.output().map_err(|e| format!("{}: {}", cmd, e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok((stdout, stderr))
    } else {
        Err(if stderr.trim().is_empty() {
            format!("{} 退出码 {}", cmd, out.status.code().unwrap_or(-1))
        } else {
            stderr.trim().to_string()
        })
    }
}

pub fn run_ok(cmd: &str, args: &[&str]) -> bool {
    run(cmd, args).is_ok()
}

pub fn powershell(script: &str) -> Result<String, String> {
    // -EncodedCommand 避免脚本里的引号/换行被 PowerShell 重新解释。
    use base64::engine::general_purpose::STANDARD;
    let encoded = STANDARD.encode(script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>());
    run(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded],
    )
    .map(|(o, _)| o)
}

pub fn powershell_elevated(script: &str) -> Result<(), String> {
    // 写入临时 .ps1，再用 Start-Process -Verb RunAs 触发 UAC。
    let tmp = std::env::temp_dir().join(format!("veyra-svc-{}.ps1", now_ms()));
    fs::write(&tmp, script).map_err(|e| e.to_string())?;
    let launcher = format!(
        "$p = Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}') -Wait -PassThru; exit $p.ExitCode",
        tmp.to_string_lossy().replace('\'', "''")
    );
    let result = powershell(&launcher).map(|_| ());
    let _ = fs::remove_file(&tmp);
    result
}

/// 宽容的 Base64 解码（支持 URL-safe、缺 padding、空白）。
pub fn b64_decode_flexible(s: &str) -> Option<Vec<u8>> {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            _ => c,
        })
        .collect();
    let mut buf = cleaned.clone();
    while buf.len() % 4 != 0 {
        buf.push('=');
    }
    base64::engine::general_purpose::STANDARD.decode(buf).ok()
}

pub fn b64_encode(s: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(s)
}

/// 与 Electron 版一致：只有 ASCII 字母数字和 -_.~ 不编码。
pub fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

pub fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .to_string()
}

/// Windows 保留设备名与非法字符清洗，禁止路径穿越。
pub fn sanitize_name(name: &str) -> String {
    let mut s: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    // 去掉扩展名
    for ext in [".yaml", ".yml", ".js"] {
        if s.to_lowercase().ends_with(ext) {
            s.truncate(s.len() - ext.len());
            break;
        }
    }
    s = s.replace("..", "_");
    let s = s.trim_start_matches('.').to_string();
    let mut s: String = s.chars().take(64).collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        s = "profile".into();
    }
    let lower = s.to_lowercase();
    let reserved = ["con", "prn", "aux", "nul", "com1", "lpt1"]
        .iter()
        .any(|r| lower == *r);
    if reserved {
        s = format!("_{}", s);
    }
    s
}

pub fn looks_like_clash_yaml(text: &str) -> bool {
    let re = regex::Regex::new(r"(?m)^\s*(?:proxies|proxy-groups|rules|mixed-port|port|socks-port)\s*:")
        .unwrap();
    re.is_match(text)
}

/// 取文件名中的可读名（URL 路径最后一段）。
pub fn guess_name_from_url(url: &str) -> String {
    let parsed = url::Url::parse(url).ok();
    if let Some(u) = parsed {
        if let Some(last) = u.path_segments().and_then(|s| s.last()) {
            let cleaned = sanitize_name(last);
            if !cleaned.is_empty() && cleaned != "profile" {
                return cleaned;
            }
        }
    }
    format!("sub-{}.yaml", now_ms())
}

/// 订阅可读名：优先域名（去 www.），否则路径段。
pub fn subscription_display_name(url: &str) -> String {
    if let Ok(u) = url::Url::parse(url) {
        let host = u.host_str().unwrap_or("").trim_start_matches("www.");
        if !host.is_empty() {
            return host.to_string();
        }
    }
    guess_name_from_url(url)
}

pub fn json_str(v: &Value, key: &str, default: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default.to_string())
}

pub fn json_bool(v: &Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(default)
}

pub fn json_u16(v: &Value, key: &str, default: u16) -> u16 {
    v.get(key)
        .and_then(|x| x.as_u64())
        .map(|n| n as u16)
        .unwrap_or(default)
}

/// 把任意字符串写成 YAML 安全的标量（尽量不加引号）。
pub fn yaml_scalar(s: &str) -> String {
    if s.is_empty()
        || s.chars().any(|c| {
            matches!(
                c,
                ':' | '#' | '[' | ']' | '{' | '}' | '|' | '>' | '&' | '*' | '!' | '?' | ',' | '@' | '`'
            )
        })
    {
        serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s))
    } else {
        s.to_string()
    }
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn dir_of(path: &Path) -> PathBuf {
    path.parent().map(|p| p.to_path_buf()).unwrap_or_default()
}

/// 读取文本并剥掉 UTF-8 BOM。
pub fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim_start_matches('\u{feff}').to_string())
}

/// 把 JSON 值里的 null 递归清理（部分内核接口不接受 null）。
pub fn drop_nulls(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.retain(|_, val| !val.is_null());
            for val in map.values_mut() {
                drop_nulls(val);
            }
        }
        Value::Array(arr) => arr.retain(|x| !x.is_null()),
        _ => {}
    }
}
