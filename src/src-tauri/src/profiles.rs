//! 档案索引与订阅档案的增删改查（对齐 Electron profiles.cjs）。
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::state::Paths;
use crate::util;

/// index.json「读-改-写」互斥：并发导入/开关切换/删除若同时 load→改→save，
/// 轻则丢更新，重则把索引写坏（写坏后 load_index 返回空 items，绑定关系全丢）。
/// 所有会写索引的公开入口都必须持锁；函数体内部禁止再调其他持锁入口（会死锁），
/// 需要组合操作时走 *_unlocked 变体。
static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn index_guard() -> std::sync::MutexGuard<'static, ()> {
    INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn load_index(paths: &Paths) -> Value {
    let p = paths.profiles_dir.join("index.json");
    let Some(raw) = util::read_text(&p) else {
        return json!({"items": [], "active": null});
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(mut v) if v.get("items").map(|i| i.is_array()).unwrap_or(false) => {
            if v.get("active").is_none() {
                v["active"] = Value::Null;
            }
            v
        }
        _ => {
            // 解析失败先备份坏文件，避免下一次写把损坏现场覆盖掉。
            let backup = paths
                .profiles_dir
                .join(format!("index.json.corrupt-{}", util::now_ms()));
            let _ = fs::copy(&p, backup);
            json!({"items": [], "active": null})
        }
    }
}

pub fn save_index(paths: &Paths, idx: &Value) -> Result<(), String> {
    fs::create_dir_all(&paths.profiles_dir).map_err(|e| e.to_string())?;
    util::write_json(&paths.profiles_dir.join("index.json"), idx)
}

pub fn refresh_sizes(paths: &Paths, idx: &mut Value) {
    if let Some(items) = idx.get_mut("items").and_then(|v| v.as_array_mut()) {
        for item in items {
            let file = item.get("file").and_then(|f| f.as_str()).unwrap_or("");
            let size = fs::metadata(paths.profiles_dir.join(file))
                .map(|m| m.len())
                .unwrap_or(0);
            if let Some(o) = item.as_object_mut() {
                o.insert("size".into(), json!(size));
            }
        }
    }
}

pub fn list_rich(paths: &Paths) -> Vec<Value> {
    let mut idx = load_index(paths);
    refresh_sizes(paths, &mut idx);
    let active = idx
        .get("active")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    idx.get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|it| {
                    let mut v = it.clone();
                    if let Some(o) = v.as_object_mut() {
                        let uid = it.get("uid").and_then(|u| u.as_str()).unwrap_or("");
                        o.insert("active".into(), json!(!active.is_empty() && uid == active));
                    }
                    v
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn import_local(
    paths: &Paths,
    name: &str,
    content: &str,
    kind: &str,
    url: Option<&str>,
) -> Result<Value, String> {
    let _guard = index_guard();
    fs::create_dir_all(&paths.profiles_dir).map_err(|e| e.to_string())?;
    let uid = uuid::Uuid::new_v4().to_string();
    let safe = util::sanitize_name(name);
    let file = format!("{}_{}.yaml", uid, safe);
    util::atomic_write_text(&paths.profiles_dir.join(&file), content)?;
    let item = json!({
        "uid": uid,
        "name": safe,
        "type": kind,
        "url": url,
        "enabled": true,
        "global": false,
        "updatedAt": util::now_ms(),
        "file": file,
        "size": content.as_bytes().len(),
    });
    let mut idx = load_index(paths);
    let mut items: Vec<Value> = idx
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    items.retain(|x| x.get("uid").and_then(|u| u.as_str()) != Some(uid.as_str()));
    items.insert(0, item.clone());
    idx["items"] = Value::Array(items);
    if kind == "remote" || kind == "local" {
        idx["active"] = json!(uid);
    }
    save_index(paths, &idx)?;
    Ok(item)
}

const ENHANCE_KINDS: [&str; 5] = ["merge", "script", "rules", "proxies", "groups"];

pub fn create_enhance(paths: &Paths, kind: &str, name: &str, global: bool) -> Result<Value, String> {
    let _guard = index_guard();
    if !ENHANCE_KINDS.contains(&kind) {
        return Err("仅支持 merge / script / rules / proxies / groups".into());
    }
    fs::create_dir_all(&paths.profiles_dir).map_err(|e| e.to_string())?;
    let uid = uuid::Uuid::new_v4().to_string();
    let safe = util::sanitize_name(name);
    let ext = if kind == "script" { "js" } else { "yaml" };
    let file = format!("{}_{}.{}", uid, safe, ext);
    let content = match kind {
        "script" => "function main(config, profileName) {\n  // 返回修改后的 Clash 配置对象\n  return config;\n}\n".to_string(),
        "rules" => "# Rules 增强（写入 rules 数组，或用 prepend-rules / append-rules / delete-rules）\nprepend-rules:\n  # - DOMAIN-SUFFIX,example.com,PROXY\n".to_string(),
        "proxies" => "# Proxies 增强（prepend-proxies / append-proxies / delete-proxies）\nprepend-proxies:\n  # - { name: my-ss, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: pwd }\n".to_string(),
        "groups" => "# Groups 增强（prepend-proxy-groups / append-proxy-groups / delete-proxy-groups）\nprepend-proxy-groups:\n  # - { name: MyGroup, type: select, proxies: [DIRECT] }\n".to_string(),
        _ => "# Veyra Merge（Verge 风格）\n# prepend-rules / append-rules / delete-rules\n# prepend-proxies / append-proxies / delete-proxies\n# prepend-proxy-groups / append-proxy-groups / delete-proxy-groups\n# 其它字段 deep-merge\n".to_string(),
    };
    util::atomic_write_text(&paths.profiles_dir.join(&file), &content)?;
    let item = json!({
        "uid": uid,
        "name": safe,
        "type": kind,
        "url": Value::Null,
        "enabled": true,
        "global": global,
        "updatedAt": util::now_ms(),
        "file": file,
        "size": content.as_bytes().len(),
    });
    let mut idx = load_index(paths);
    let mut items: Vec<Value> = idx
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    items.push(item.clone());
    idx["items"] = Value::Array(items);
    save_index(paths, &idx)?;
    Ok(item)
}

pub fn set_profile_binds(paths: &Paths, uid: &str, binds: &Value) -> Result<Value, String> {
    let _guard = index_guard();
    let mut idx = load_index(paths);
    let items = idx
        .get_mut("items")
        .and_then(|v| v.as_array_mut())
        .ok_or("配置不存在")?;
    let item = items
        .iter_mut()
        .find(|x| x.get("uid").and_then(|u| u.as_str()) == Some(uid))
        .ok_or("配置不存在")?;
    let ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if ty != "remote" && ty != "local" {
        return Err("只能给 Remote/Local 绑定扩展".into());
    }
    let mut out = serde_json::Map::new();
    for key in ["merge", "script", "rules", "proxies", "groups"] {
        out.insert(
            key.to_string(),
            binds.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    item["binds"] = Value::Object(out);
    let result = item.clone();
    save_index(paths, &idx)?;
    Ok(result)
}

pub fn set_enabled(paths: &Paths, uid: &str, enabled: bool) -> Result<Value, String> {
    let _guard = index_guard();
    let mut idx = load_index(paths);
    let items = idx
        .get_mut("items")
        .and_then(|v| v.as_array_mut())
        .ok_or("配置不存在")?;
    let item = items
        .iter_mut()
        .find(|x| x.get("uid").and_then(|u| u.as_str()) == Some(uid))
        .ok_or("配置不存在")?;
    item["enabled"] = json!(enabled);
    save_index(paths, &idx)?;
    Ok(idx)
}

pub fn set_active(paths: &Paths, uid: &str) -> Result<Value, String> {
    let _guard = index_guard();
    let mut idx = load_index(paths);
    let items = idx
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let item = items
        .iter()
        .find(|x| x.get("uid").and_then(|u| u.as_str()) == Some(uid))
        .ok_or("配置不存在")?;
    let ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if ty != "remote" && ty != "local" {
        return Err("只能激活 Remote / Local 主配置".into());
    }
    idx["active"] = json!(uid);
    save_index(paths, &idx)?;
    Ok(idx)
}

pub fn delete_profile(paths: &Paths, uid: &str) {
    let _guard = index_guard();
    delete_profile_unlocked(paths, uid);
}

fn delete_profile_unlocked(paths: &Paths, uid: &str) {
    let mut idx = load_index(paths);
    let mut items: Vec<Value> = idx
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let Some(pos) = items
        .iter()
        .position(|x| x.get("uid").and_then(|u| u.as_str()) == Some(uid))
    else {
        return;
    };
    let item = items.remove(pos);
    if let Some(file) = item.get("file").and_then(|f| f.as_str()) {
        let _ = fs::remove_file(paths.profiles_dir.join(file));
    }
    let was_active = idx.get("active").and_then(|a| a.as_str()) == Some(uid);
    if was_active {
        let next = items
            .iter()
            .find(|x| {
                matches!(
                    x.get("type").and_then(|t| t.as_str()),
                    Some("remote") | Some("local")
                )
            })
            .and_then(|x| x.get("uid").cloned())
            .unwrap_or(Value::Null);
        idx["active"] = next;
    }
    idx["items"] = Value::Array(items);
    let _ = save_index(paths, &idx);
}

pub fn read_content(paths: &Paths, uid: &str) -> Result<String, String> {
    let idx = load_index(paths);
    let file = idx
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|a| {
            a.iter()
                .find(|i| i.get("uid").and_then(|u| u.as_str()) == Some(uid))
        })
        .and_then(|i| i.get("file"))
        .and_then(|f| f.as_str())
        .ok_or("配置不存在")?;
    fs::read_to_string(paths.profiles_dir.join(file)).map_err(|e| e.to_string())
}

pub fn write_content(paths: &Paths, uid: &str, content: &str) -> Result<(), String> {
    let _guard = index_guard();
    write_content_unlocked(paths, uid, content)
}

fn write_content_unlocked(paths: &Paths, uid: &str, content: &str) -> Result<(), String> {
    let mut idx = load_index(paths);
    let mut file: Option<String> = None;
    if let Some(items) = idx.get_mut("items").and_then(|v| v.as_array_mut()) {
        for item in items.iter_mut() {
            if item.get("uid").and_then(|u| u.as_str()) == Some(uid) {
                file = item.get("file").and_then(|f| f.as_str()).map(|s| s.to_string());
                item["updatedAt"] = json!(util::now_ms());
                item["size"] = json!(content.as_bytes().len());
            }
        }
    }
    let file = file.ok_or("配置不存在")?;
    util::atomic_write_text(&paths.profiles_dir.join(file), content)?;
    save_index(paths, &idx)
}

/// 按 URL 原地更新远程订阅，并清理同 URL 的重复项。
pub fn update_remote_by_url(paths: &Paths, url: &str, content: &str) -> Result<Option<Value>, String> {
    let _guard = index_guard();
    let idx = load_index(paths);
    let active = idx
        .get("active")
        .and_then(|a| a.as_str())
        .unwrap_or("")
        .to_string();
    let mut dups: Vec<Value> = idx
        .get("items")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter(|x| {
                    x.get("type").and_then(|t| t.as_str()) == Some("remote")
                        && x.get("url").and_then(|u| u.as_str()) == Some(url)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if dups.is_empty() {
        return Ok(None);
    }
    dups.sort_by(|a, b| {
        let aa = a.get("uid").and_then(|u| u.as_str()) == Some(active.as_str());
        let bb = b.get("uid").and_then(|u| u.as_str()) == Some(active.as_str());
        bb.cmp(&aa).then_with(|| {
            let at = a.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
            let bt = b.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
            bt.cmp(&at)
        })
    });
    let keep_uid = dups[0]
        .get("uid")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    write_content_unlocked(paths, &keep_uid, content)?;
    for dup in dups.iter().skip(1) {
        if let Some(uid) = dup.get("uid").and_then(|u| u.as_str()) {
            delete_profile_unlocked(paths, uid);
        }
    }
    let out = load_index(paths);
    Ok(out
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|a| {
            a.iter()
                .find(|x| x.get("uid").and_then(|u| u.as_str()) == Some(keep_uid.as_str()))
                .cloned()
        }))
}

pub fn active_main_text(paths: &Paths) -> Option<String> {
    let idx = load_index(paths);
    if let Some(active) = idx.get("active").and_then(|a| a.as_str()) {
        if let Some(item) = idx
            .get("items")
            .and_then(|v| v.as_array())
            .and_then(|a| {
                a.iter()
                    .find(|x| x.get("uid").and_then(|u| u.as_str()) == Some(active))
            })
        {
            if matches!(
                item.get("type").and_then(|t| t.as_str()),
                Some("remote") | Some("local")
            ) {
                if let Some(file) = item.get("file").and_then(|f| f.as_str()) {
                    if let Ok(text) = fs::read_to_string(paths.profiles_dir.join(file)) {
                        return Some(text);
                    }
                }
            }
        }
    }
    util::read_text(&paths.runtime)
}

pub fn is_legacy_display_name(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    let re_uuid = regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-").unwrap();
    re_uuid.is_match(name)
        || name.to_lowercase().ends_with(".yaml")
        || name.to_lowercase().ends_with(".yml")
        || name.eq_ignore_ascii_case("subscription")
}

pub fn rename_by_url(paths: &Paths, url: &str, name: &str, force: bool) -> Option<Value> {
    if url.is_empty() || name.is_empty() {
        return None;
    }
    let _guard = index_guard();
    let mut idx = load_index(paths);
    let safe = util::sanitize_name(name);
    let items = idx.get_mut("items")?.as_array_mut()?;
    let item = items.iter_mut().find(|x| {
        x.get("type").and_then(|t| t.as_str()) == Some("remote")
            && x.get("url").and_then(|u| u.as_str()) == Some(url)
    })?;
    let current = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
    if current == safe {
        return Some(item.clone());
    }
    if !force && !is_legacy_display_name(current) {
        return Some(item.clone());
    }
    item["name"] = json!(safe);
    let out = item.clone();
    let _ = save_index(paths, &idx);
    Some(out)
}

/// 旧扁平 yaml → index（仅当 index 为空）。
pub fn migrate_legacy_files(paths: &Paths) -> Value {
    let _guard = index_guard();
    let mut idx = load_index(paths);
    let items_len = idx
        .get("items")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    if items_len > 0 || !paths.profiles_dir.exists() {
        return idx;
    }
    let Ok(rd) = fs::read_dir(&paths.profiles_dir) else {
        return idx;
    };
    let mut items: Vec<Value> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !(lower.ends_with(".yaml") || lower.ends_with(".yml")) || name == "index.json" {
            continue;
        }
        let uid = uuid::Uuid::new_v4().to_string();
        let safe = util::sanitize_name(&name);
        let new_file = format!("{}_{}.yaml", uid, safe);
        let src = paths.profiles_dir.join(&name);
        let dst = paths.profiles_dir.join(&new_file);
        if src != dst {
            if fs::rename(&src, &dst).is_err() {
                let _ = fs::copy(&src, &dst);
            }
        }
        let size = fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
        items.push(json!({
            "uid": uid,
            "name": safe,
            "type": "local",
            "url": Value::Null,
            "enabled": true,
            "global": false,
            "updatedAt": util::now_ms(),
            "file": new_file,
            "size": size,
        }));
    }
    if items.is_empty() {
        return idx;
    }
    if let Some(first) = items.first().and_then(|x| x.get("uid")).cloned() {
        idx["active"] = first;
    }
    idx["items"] = Value::Array(items);
    let _ = save_index(paths, &idx);
    idx
}

/// `listProfiles` 的兜底：index 为空但目录里有文件。
pub fn fallback_files(paths: &Paths) -> Vec<Value> {
    let Ok(rd) = fs::read_dir(&paths.profiles_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !(lower.ends_with(".yaml") || lower.ends_with(".yml") || lower.ends_with(".js")) {
            continue;
        }
        let full = paths.profiles_dir.join(&name);
        let size = fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
        out.push(json!({
            "name": name, "path": full.to_string_lossy(), "size": size,
            "uid": name, "type": "local", "enabled": true, "global": false,
            "url": Value::Null, "updatedAt": 0,
        }));
    }
    out
}

pub fn item_path(paths: &Paths, item: &Value) -> Option<PathBuf> {
    item.get("file")
        .and_then(|f| f.as_str())
        .map(|f| paths.profiles_dir.join(f))
}

pub fn active_uid(paths: &Paths) -> Option<String> {
    load_index(paths)
        .get("active")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string())
}

#[allow(dead_code)]
pub fn index_path(paths: &Paths) -> PathBuf {
    paths.profiles_dir.join("index.json")
}

#[allow(dead_code)]
pub fn exists_file(path: &Path) -> bool {
    path.exists()
}
