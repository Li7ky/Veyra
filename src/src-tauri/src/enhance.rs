//! 增强配置引擎：Merge / Script / Rules / Proxies / Groups（对齐 Electron enhance.cjs）。
use serde_json::{json, Map, Value};
use std::fs;

use crate::profiles;
use crate::state::Paths;
use crate::util;

#[derive(Clone)]
pub struct EnhanceOpts {
    pub mixed_port: u16,
    pub controller_port: u16,
    pub secret: String,
    pub allow_lan: bool,
    pub log_level: String,
    pub bind_address: String,
    pub dns_override: bool,
    pub dns_config: Value,
    pub tun_config: Value,
    pub unified_delay: bool,
    pub tcp_concurrent: bool,
}

pub fn build_tun_config(settings: &Value) -> Value {
    let get = |k: &str| settings.get(k).cloned().unwrap_or(Value::Null);
    json!({
        "enable": util::json_bool(settings, "tunEnable", false),
        "stack": get("tunStack").as_str().unwrap_or("gvisor"),
        "auto-route": settings.get("tunAutoRoute").and_then(|v| v.as_bool()).unwrap_or(true),
        "strict-route": util::json_bool(settings, "tunStrictRoute", false),
        "auto-detect-interface": settings.get("tunAutoDetect").and_then(|v| v.as_bool()).unwrap_or(true),
        "sniffer": util::json_bool(settings, "tunSniff", true),
        "dns-hijack": settings.get("tunDnsHijack").cloned()
            .unwrap_or_else(|| json!(["any:53", "tcp://any:53"])),
        "mtu": settings.get("tunMtu").and_then(|v| v.as_u64()).unwrap_or(9000),
        "device": get("tunDevice").as_str().unwrap_or("Veyra"),
    })
}

pub fn build_dns_config(settings: &Value) -> Value {
    let get = |k: &str| settings.get(k).cloned().unwrap_or(Value::Null);
    json!({
        "enable": settings.get("dnsEnable").and_then(|v| v.as_bool()).unwrap_or(true),
        "listen": get("dnsListen").as_str().unwrap_or("0.0.0.0:1053"),
        "ipv6": util::json_bool(settings, "dnsIpv6", false),
        "enhanced-mode": get("dnsMode").as_str().unwrap_or("fake-ip"),
        "fake-ip-range": get("dnsFakeIpRange").as_str().unwrap_or("198.18.0.1/16"),
        "fake-ip-filter": settings.get("dnsFakeIpFilter").cloned()
            .unwrap_or_else(|| json!(["*.lan", "localhost", "*.local"])),
        "nameserver": settings.get("dnsNameserver").cloned()
            .unwrap_or_else(|| json!(["https://doh.pub/dns-query", "tls://dns.alidns.com"])),
        "fallback": settings.get("dnsFallback").cloned()
            .unwrap_or_else(|| json!(["tls://1.1.1.1", "tls://8.8.8.8"])),
        "default-nameserver": settings.get("dnsDefaultNs").cloned()
            .unwrap_or_else(|| json!(["223.5.5.5", "119.29.29.29"])),
        "hosts": settings.get("dnsHosts").cloned().unwrap_or_else(|| json!({})),
    })
}

fn as_map(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn deep_merge(base: &Value, patch: &Value) -> Value {
    let mut out = as_map(base);
    for (k, v) in as_map(patch) {
        if v.is_object()
            && out
                .get(&k)
                .map(|b| b.is_object())
                .unwrap_or(false)
        {
            let merged = deep_merge(out.get(&k).unwrap_or(&Value::Null), &v);
            out.insert(k, merged);
        } else {
            out.insert(k, v);
        }
    }
    Value::Object(out)
}

fn prepend(cfg: &mut Map<String, Value>, key: &str, arr: &Value, warnings: &mut Vec<String>) {
    let Some(items) = arr.as_array() else {
        warnings.push(format!("{}: prepend 值不是数组", key));
        return;
    };
    let mut base = cfg
        .get(key)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut next = items.clone();
    next.append(&mut base);
    cfg.insert(key.to_string(), Value::Array(next));
}

fn append(cfg: &mut Map<String, Value>, key: &str, arr: &Value, warnings: &mut Vec<String>) {
    let Some(items) = arr.as_array() else {
        warnings.push(format!("{}: append 值不是数组", key));
        return;
    };
    let mut base = cfg
        .get(key)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    base.extend(items.clone());
    cfg.insert(key.to_string(), Value::Array(base));
}

fn delete_names(cfg: &mut Map<String, Value>, key: &str, names: &Value, field: &str, warnings: &mut Vec<String>) {
    let Some(list) = names.as_array() else {
        warnings.push(format!("delete-{}: 需要名称数组", key));
        return;
    };
    let drop: std::collections::HashSet<String> = list
        .iter()
        .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))
        .collect();
    if let Some(arr) = cfg.get_mut(key).and_then(|v| v.as_array_mut()) {
        arr.retain(|item| {
            let name = if field.is_empty() {
                item.as_str().map(|s| s.to_string()).unwrap_or_else(|| item.to_string())
            } else {
                item.get(field)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            };
            !drop.contains(&name)
        });
    }
}

pub fn apply_merge(config: &mut Value, merge_text: &str) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    let parsed: Value = serde_yaml::from_str(merge_text)
        .map_err(|e| format!("Merge YAML 解析失败: {}", e))?;
    if !parsed.is_object() {
        return Ok(warnings);
    }
    let Some(cfg) = config.as_object_mut() else {
        return Ok(warnings);
    };
    for (key, v) in as_map(&parsed) {
        if key.is_empty() || key.starts_with('#') {
            continue;
        }
        match key.as_str() {
            "prepend-rules" => prepend(cfg, "rules", &v, &mut warnings),
            "append-rules" => append(cfg, "rules", &v, &mut warnings),
            "prepend-proxies" => prepend(cfg, "proxies", &v, &mut warnings),
            "append-proxies" => append(cfg, "proxies", &v, &mut warnings),
            "prepend-proxy-groups" => prepend(cfg, "proxy-groups", &v, &mut warnings),
            "append-proxy-groups" => append(cfg, "proxy-groups", &v, &mut warnings),
            "delete-rules" => delete_names(cfg, "rules", &v, "", &mut warnings),
            "delete-proxies" => delete_names(cfg, "proxies", &v, "name", &mut warnings),
            "delete-proxy-groups" => delete_names(cfg, "proxy-groups", &v, "name", &mut warnings),
            "rules" | "proxies" | "proxy-groups" | "proxy-providers" | "rule-providers" => {
                if v.is_null() {
                    warnings.push(format!("{}: 内容为空，已忽略", key));
                } else {
                    cfg.insert(key, v);
                }
            }
            _ => {
                if v.is_object()
                    && cfg.get(&key).map(|b| b.is_object()).unwrap_or(false)
                {
                    let merged = deep_merge(cfg.get(&key).unwrap(), &v);
                    cfg.insert(key, merged);
                } else {
                    cfg.insert(key, v);
                }
            }
        }
    }
    Ok(warnings)
}

/// 在 QuickJS 中执行 `function main(config, profileName)`，返回新配置。
pub fn apply_script(config: &Value, script: &str, profile_name: &str) -> Result<Value, String> {
    let rt = rquickjs::Runtime::new().map_err(|e| format!("Script 运行时初始化失败: {}", e))?;
    let ctx = rquickjs::Context::full(&rt)
        .map_err(|e| format!("Script 上下文初始化失败: {}", e))?;
    let input = serde_json::to_string(config).map_err(|e| e.to_string())?;
    ctx.with(|ctx| {
        ctx.globals()
            .set("__veyraInput", input)
            .map_err(|e| format!("Script 参数注入失败: {}", e))?;
        ctx.globals()
            .set("__veyraProfileName", profile_name)
            .map_err(|e| format!("Script 参数注入失败: {}", e))?;
        ctx.eval::<(), _>(script)
            .map_err(|e| format!("Script 执行失败: {}", e))?;
        let out: String = ctx
            .eval("JSON.stringify(main(JSON.parse(__veyraInput), __veyraProfileName))")
            .map_err(|e| format!("Script main() 执行失败: {}", e))?;
        let parsed: Value = serde_json::from_str(&out)
            .map_err(|e| format!("Script 返回内容不是合法配置: {}", e))?;
        if !parsed.is_object() {
            return Err("Script 必须返回配置对象".into());
        }
        Ok(parsed)
    })
}

fn cleanup_groups(config: &mut Value) {
    let mut names: std::collections::HashSet<String> = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(arr) = config.get("proxies").and_then(|v| v.as_array()) {
        for p in arr {
            if let Some(n) = p.get("name").and_then(|v| v.as_str()) {
                names.insert(n.to_string());
            }
        }
    }
    if let Some(arr) = config.get("proxy-groups").and_then(|v| v.as_array()) {
        for g in arr {
            if let Some(n) = g.get("name").and_then(|v| v.as_str()) {
                names.insert(n.to_string());
            }
        }
    }
    if let Some(arr) = config.get_mut("proxy-groups").and_then(|v| v.as_array_mut()) {
        for g in arr {
            if let Some(list) = g.get_mut("proxies").and_then(|v| v.as_array_mut()) {
                list.retain(|n| match n.as_str() {
                    Some(s) => names.contains(s),
                    None => true,
                });
            }
        }
    }
}

fn ensure_basic_rules(config: &mut Value, warnings: &mut Vec<String>) {
    let has_rules = config
        .get("rules")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().any(|x| !x.is_null()))
        .unwrap_or(false);
    if has_rules {
        return;
    }
    let group = config
        .get("proxy-groups")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|g| g.get("name"))
        .and_then(|n| n.as_str())
        .or_else(|| {
            config
                .get("proxies")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
        })
        .unwrap_or("DIRECT")
        .to_string();
    config["rules"] = json!([
        "GEOIP,LAN,DIRECT,no-resolve",
        "GEOIP,CN,DIRECT",
        format!("MATCH,{}", group),
    ]);
    warnings.push("订阅未包含 rules，已补入内置基础规则（局域网/国内直连，其它走代理）".into());
}

fn inject_defaults(config: &mut Value, opts: &EnhanceOpts) {
    config["mixed-port"] = json!(opts.mixed_port);
    let bind = if opts.bind_address == "0.0.0.0" || opts.allow_lan {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    config["external-controller"] = json!(format!("{}:{}", bind, opts.controller_port));
    config["bind-address"] = json!(opts.bind_address);
    config["secret"] = json!(opts.secret);
    config["allow-lan"] = json!(opts.allow_lan);
    config["log-level"] = json!(opts.log_level);
    if config.get("mode").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_none() {
        config["mode"] = json!("rule");
    }
    if opts.dns_override && !opts.dns_config.is_null() {
        config["dns"] = opts.dns_config.clone();
    } else if config.get("dns").is_none() {
        config["dns"] = json!({
            "enable": true,
            "enhanced-mode": "fake-ip",
            "fake-ip-range": "198.18.0.1/16",
            "nameserver": ["223.5.5.5", "8.8.8.8"],
        });
    }
    if !opts.tun_config.is_null() {
        let base = config.get("tun").cloned().unwrap_or_else(|| json!({}));
        config["tun"] = deep_merge(&base, &opts.tun_config);
    }
    config["unified-delay"] = json!(opts.unified_delay);
    config["tcp-concurrent"] = json!(opts.tcp_concurrent);
}

fn apply_item(
    config: &mut Value,
    item: &Value,
    text: &str,
    profile_name: &str,
    warnings: &mut Vec<String>,
    script_logs: &mut Vec<String>,
    scope: &str,
) {
    let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if matches!(ty, "merge" | "rules" | "proxies" | "groups") {
        match apply_merge(config, text) {
            Ok(ws) => {
                for w in ws {
                    warnings.push(format!("{} {} {}: {}", scope, ty, name, w));
                }
            }
            Err(e) => warnings.push(format!("{} {} {}: {}", scope, ty, name, e)),
        }
    } else if ty == "script" {
        match apply_script(config, text, profile_name) {
            Ok(next) => {
                *config = next;
                script_logs.push(format!("{} script {}: ok", scope, name));
            }
            Err(e) => warnings.push(format!("{} script {}: {}", scope, name, e)),
        }
    }
}

/// 执行完整增强流程，返回 (文本, 警告, 脚本日志)。
pub fn enhance(
    paths: &Paths,
    opts: &EnhanceOpts,
) -> Result<(String, Vec<String>, Vec<String>), String> {
    let mut warnings = Vec::new();
    let mut script_logs = Vec::new();
    let idx = profiles::load_index(paths);
    let active = idx
        .get("active")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let items: Vec<Value> = idx
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let main_item = items.iter().find(|x| {
        x.get("uid").and_then(|u| u.as_str()) == Some(active.as_str())
            && matches!(
                x.get("type").and_then(|t| t.as_str()),
                Some("remote") | Some("local")
            )
    });

    let mut config = Value::Object(Map::new());
    if let Some(item) = main_item {
        if let Some(fp) = profiles::item_path(paths, item) {
            match fs::read_to_string(&fp) {
                Ok(text) => match serde_yaml::from_str::<Value>(&text) {
                    Ok(v) if v.is_object() => config = v,
                    Ok(_) => {}
                    Err(e) => warnings.push(format!("主配置解析失败: {}", e)),
                },
                Err(e) => warnings.push(format!("主配置读取失败: {}", e)),
            }
        }
    } else if let Some(text) = util::read_text(&paths.runtime) {
        if let Ok(v) = serde_yaml::from_str::<Value>(&text) {
            if v.is_object() {
                config = v;
            }
        }
    }

    let profile_name = main_item
        .and_then(|x| x.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    let enhance_types = ["merge", "script", "rules", "proxies", "groups"];
    let is_enhance = |x: &Value| {
        x.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
            && enhance_types.contains(&x.get("type").and_then(|t| t.as_str()).unwrap_or(""))
    };

    // 1) 全局增强
    for item in items.iter().filter(|x| {
        is_enhance(x) && x.get("global").and_then(|g| g.as_bool()).unwrap_or(false)
    }) {
        let Some(fp) = profiles::item_path(paths, item) else {
            continue;
        };
        if !fp.exists() {
            warnings.push(format!(
                "global {} {}: 文件缺失({})，已跳过",
                item.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                item.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                item.get("file").and_then(|v| v.as_str()).unwrap_or("")
            ));
            continue;
        }
        let text = fs::read_to_string(&fp).unwrap_or_default();
        let mut next = config.clone();
        apply_item(
            &mut next,
            item,
            &text,
            &profile_name,
            &mut warnings,
            &mut script_logs,
            "global",
        );
        config = next;
    }

    // 2) 订阅级绑定
    let binds = main_item
        .and_then(|x| x.get("binds"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    for key in ["rules", "proxies", "groups", "merge", "script"] {
        let Some(uid) = binds.get(key).and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(item) = items.iter().find(|x| x.get("uid").and_then(|u| u.as_str()) == Some(uid))
        else {
            continue;
        };
        if !item.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(fp) = profiles::item_path(paths, item) else {
            continue;
        };
        if !fp.exists() {
            warnings.push(format!(
                "bound {} {}: 文件缺失({})，已跳过",
                item.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                item.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                item.get("file").and_then(|v| v.as_str()).unwrap_or("")
            ));
            continue;
        }
        let text = fs::read_to_string(&fp).unwrap_or_default();
        let mut next = config.clone();
        apply_item(
            &mut next,
            item,
            &text,
            &profile_name,
            &mut warnings,
            &mut script_logs,
            "bound",
        );
        config = next;
    }

    // 3) 未绑定的本地/全局之外增强
    let bind_uids: std::collections::HashSet<String> = binds
        .as_object()
        .map(|m| {
            m.values()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    for item in items.iter().filter(|x| {
        is_enhance(x)
            && !x.get("global").and_then(|g| g.as_bool()).unwrap_or(false)
            && !bind_uids.contains(x.get("uid").and_then(|u| u.as_str()).unwrap_or(""))
    }) {
        let Some(fp) = profiles::item_path(paths, item) else {
            continue;
        };
        if !fp.exists() {
            warnings.push(format!(
                "profile {} {}: 文件缺失({})，已跳过",
                item.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                item.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                item.get("file").and_then(|v| v.as_str()).unwrap_or("")
            ));
            continue;
        }
        let text = fs::read_to_string(&fp).unwrap_or_default();
        let mut next = config.clone();
        apply_item(
            &mut next,
            item,
            &text,
            &profile_name,
            &mut warnings,
            &mut script_logs,
            "profile",
        );
        config = next;
    }

    if !config.is_object() {
        config = json!({});
    }
    inject_defaults(&mut config, opts);
    cleanup_groups(&mut config);
    ensure_basic_rules(&mut config, &mut warnings);

    let text = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
    Ok((text, warnings, script_logs))
}

pub fn enhance_and_write(paths: &Paths, opts: &EnhanceOpts) -> Result<(String, Vec<String>, Vec<String>), String> {
    let (text, warnings, logs) = enhance(paths, opts)?;
    util::atomic_write_text(&paths.runtime, &text)?;
    Ok((text, warnings, logs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_prepends_rules() {
        let mut cfg = json!({"rules": ["MATCH,DIRECT"]});
        let ws = apply_merge(&mut cfg, "prepend-rules:\n  - DOMAIN,a.com,PROXY\n").unwrap();
        assert!(ws.is_empty());
        assert_eq!(cfg["rules"][0], "DOMAIN,a.com,PROXY");
        assert_eq!(cfg["rules"][1], "MATCH,DIRECT");
    }

    #[test]
    fn merge_ignores_null_rules() {
        let mut cfg = json!({"rules": ["MATCH,DIRECT"]});
        let ws = apply_merge(&mut cfg, "rules:\n").unwrap();
        assert_eq!(cfg["rules"].as_array().unwrap().len(), 1);
        assert!(!ws.is_empty());
    }

    #[test]
    fn script_roundtrip() {
        let cfg = json!({"proxies": []});
        let out = apply_script(
            &cfg,
            "function main(c, n) { c.extra = n; return c; }",
            "demo",
        )
        .unwrap();
        assert_eq!(out["extra"], "demo");
        assert!(apply_script(&cfg, "function main(c){ return 1; }", "x").is_err());
    }
}
