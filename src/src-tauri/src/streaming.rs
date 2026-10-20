//! 流媒体解锁探测（经本地混合端口，对齐 Electron streaming-unlock.cjs）。
use serde_json::{json, Value};
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

struct Check {
    id: &'static str,
    title: &'static str,
}

pub const CHECKS: &[Check] = &[
    Check { id: "bilibili-cn", title: "哔哩哔哩大陆" },
    Check { id: "bilibili-hk", title: "哔哩哔哩港澳台" },
    Check { id: "bahamut", title: "Bahamut Anime" },
    Check { id: "chatgpt", title: "ChatGPT Web" },
    Check { id: "claude", title: "Claude" },
    Check { id: "disney", title: "Disney+" },
    Check { id: "gemini", title: "Gemini" },
    Check { id: "netflix", title: "Netflix" },
    Check { id: "prime", title: "Prime Video" },
    Check { id: "spotify", title: "Spotify" },
    Check { id: "tiktok", title: "TikTok" },
    Check { id: "youtube", title: "YouTube Premium" },
];

fn client(port: u16) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{}", port)).map_err(|e| e.to_string())?)
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(14))
        .user_agent(UA)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

async fn via_proxy(url: &str, port: u16, method: &str, body: Option<&str>) -> Result<(u16, String), String> {
    let c = client(port)?;
    let mut req = match method {
        "POST" => c.post(url),
        _ => c.get(url),
    };
    if let Some(b) = body {
        req = req
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(b.to_string());
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, text))
}

fn trace_loc(body: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?i)loc=([A-Z]{2,3})").unwrap();
    re.captures(body)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_uppercase())
}

async fn cf_trace(port: u16) -> Option<String> {
    via_proxy("https://www.cloudflare.com/cdn-cgi/trace", port, "GET", None)
        .await
        .ok()
        .and_then(|(s, body)| if s == 200 { trace_loc(&body) } else { None })
}

fn pack(ok: bool, fail: bool, region: Option<String>, note: &str) -> Value {
    json!({
        "ok": ok && !fail,
        "fail": fail,
        "region": region,
        "note": note,
    })
}

async fn run_check(id: &str, port: u16) -> Value {
    macro_rules! req {
        ($url:expr) => {
            match via_proxy($url, port, "GET", None).await {
                Ok(v) => v,
                Err(e) => return pack(false, true, None, &friendly_fail(&e)),
            }
        };
    }
    match id {
        "bilibili-cn" => {
            let (s, _) = req!("https://api.bilibili.com/x/web-interface/nav");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if (200..400).contains(&s) {
                pack(true, false, Some("CN".into()), "支持")
            } else {
                pack(false, false, None, "不支持")
            }
        }
        "bilibili-hk" => {
            let (s, body) = req!("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=285145&qn=1&fnval=16&fourk=1");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if regex::Regex::new(r"(?i)area_limit|10403|-10403").unwrap().is_match(&body) {
                pack(false, false, None, "不支持")
            } else if (200..400).contains(&s) {
                pack(true, false, None, "支持")
            } else {
                pack(false, false, None, "不支持")
            }
        }
        "bahamut" => {
            let (s, body) = req!("https://ani.gamer.com.tw/ajax/getdeviceid.php");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if (200..400).contains(&s) && body.to_lowercase().contains("deviceid") {
                pack(true, false, Some("TW".into()), "支持")
            } else {
                pack(false, s >= 500, None, if s >= 500 { "测试失败" } else { "不支持" })
            }
        }
        "chatgpt" => {
            let (s, body) = req!("https://chatgpt.com/cdn-cgi/trace");
            if s == 0 {
                return pack(false, true, None, "网络连接问题");
            }
            let loc = trace_loc(&body);
            let blocked = loc
                .as_deref()
                .map(|l| regex::Regex::new(r"(?i)^CN|HK|MO|RU|IR|KP|CU|SY$").unwrap().is_match(l))
                .unwrap_or(false);
            if (200..400).contains(&s) {
                pack(!blocked, false, loc, if blocked { "不支持" } else { "支持" })
            } else {
                pack(false, true, loc, "测试失败")
            }
        }
        "claude" => {
            let (s, body) = req!("https://claude.ai/cdn-cgi/trace");
            if s == 0 {
                return pack(false, true, None, "网络连接问题");
            }
            let loc = trace_loc(&body);
            if s == 403 || s == 451 {
                pack(false, false, loc, "不支持")
            } else if (200..400).contains(&s) {
                pack(true, false, loc, "支持")
            } else {
                pack(false, true, loc, "测试失败")
            }
        }
        "disney" => {
            let (s, body) = req!("https://www.disneyplus.com");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if s == 403
                || s == 451
                || body.to_lowercase().contains("not available")
            {
                pack(false, false, None, "不支持")
            } else if (200..400).contains(&s) {
                let loc = cf_trace(port).await;
                pack(true, false, loc, "支持")
            } else {
                pack(false, true, None, "测试失败")
            }
        }
        "gemini" => {
            let (s, body) = req!("https://gemini.google.com");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if s == 403 || body.to_lowercase().contains("not available in your country") {
                pack(false, false, None, "不支持")
            } else if (200..400).contains(&s) {
                let loc = cf_trace(port).await;
                pack(true, false, loc, "支持")
            } else {
                pack(false, true, None, "测试失败")
            }
        }
        "netflix" => {
            let (s, _) = req!("https://www.netflix.com/title/81280792");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if s == 404 {
                pack(false, false, None, "仅自制剧")
            } else if s == 403 || s == 451 {
                pack(false, false, None, "不支持")
            } else if (200..400).contains(&s) {
                let loc = cf_trace(port).await;
                pack(true, false, loc, "支持")
            } else {
                pack(false, true, None, "测试失败")
            }
        }
        "prime" => {
            let (s, body) = req!("https://www.primevideo.com");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if s == 403 || body.to_lowercase().contains("not available") {
                pack(false, false, None, "不支持")
            } else if (200..400).contains(&s) {
                let loc = cf_trace(port).await;
                pack(true, false, loc, "支持")
            } else {
                pack(false, true, None, "测试失败")
            }
        }
        "spotify" => {
            let r = via_proxy(
                "https://spclient.wg.spotify.com/signup/public/v1/account",
                port,
                "POST",
                Some("birth_year=1999&birth_month=1&birth_day=1&country=US&key=142b583541b7b624c10c6ae3aefd2c00"),
            )
            .await;
            let (s, body) = match r {
                Ok(v) => v,
                Err(e) => return pack(false, true, None, &friendly_fail(&e)),
            };
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if regex::Regex::new(r#"(?i)status"?\s*:\s*20\b"#).unwrap().is_match(&body) || s == 200 {
                let loc = cf_trace(port).await;
                pack(true, false, loc, "支持")
            } else if regex::Regex::new(r#"(?i)restricted|not available|status"?\s*:\s*3[12]"#)
                .unwrap()
                .is_match(&body)
            {
                pack(false, false, None, "不支持")
            } else {
                pack(false, s >= 500, None, if s >= 500 { "测试失败" } else { "不支持" })
            }
        }
        "tiktok" => {
            let (s, body) =
                req!("https://www.tiktok.com/api/v1/web-cookie-privacy/config?appId=1988");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if (200..400).contains(&s) {
                let loc = regex::Regex::new(r#"(?i)"region"\s*:\s*"(\w+)""#)
                    .unwrap()
                    .captures(&body)
                    .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                    .or(cf_trace(port).await);
                pack(true, false, loc, "支持")
            } else {
                pack(false, true, None, "测试失败")
            }
        }
        "youtube" => {
            let (s, body) = req!("https://www.youtube.com/premium");
            if s == 0 {
                pack(false, true, None, "网络连接问题")
            } else if body.to_lowercase().contains("not available in your country") {
                pack(false, false, None, "不支持")
            } else if (200..400).contains(&s) {
                let loc = cf_trace(port).await;
                pack(true, false, loc, "支持")
            } else {
                pack(false, true, None, "测试失败")
            }
        }
        _ => pack(false, true, None, "未知测试项"),
    }
}

fn friendly_fail(e: &str) -> String {
    let s = e.to_lowercase();
    if s.contains("tls") || s.contains("ssl") || s.contains("certificate") {
        "测试失败 (站点 TLS 握手失败)".into()
    } else if s.contains("timeout") || s.contains("connect") || s.contains("dns") {
        "测试失败 (网络连接问题)".into()
    } else if e.len() > 40 {
        "测试失败 (探测未完成)".into()
    } else {
        e.to_string()
    }
}

pub fn catalog() -> Value {
    Value::Array(
        CHECKS
            .iter()
            .map(|c| {
                json!({
                    "id": c.id, "title": c.title, "ok": false, "fail": false,
                    "region": Value::Null, "note": "", "status": 0, "testedAt": 0,
                })
            })
            .collect(),
    )
}

pub async fn run_one(mixed_port: u16, id: &str) -> Result<Value, String> {
    let check = CHECKS.iter().find(|c| c.id == id).ok_or("未知测试项")?;
    let r = run_check(check.id, mixed_port).await;
    Ok(json!({
        "id": check.id,
        "title": check.title,
        "ok": r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        "fail": r.get("fail").and_then(|v| v.as_bool()).unwrap_or(false),
        "region": r.get("region").cloned().unwrap_or(Value::Null),
        "note": r.get("note").and_then(|v| v.as_str()).unwrap_or(""),
        "status": if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) { 200 } else if r.get("fail").and_then(|v| v.as_bool()).unwrap_or(false) { 0 } else { 403 },
        "testedAt": crate::util::now_ms(),
    }))
}

/// 串行全量测试（与 Electron 语义一致；界面显示进度）。
pub async fn run_all(mixed_port: u16) -> Value {
    let mut out = Vec::new();
    for c in CHECKS {
        out.push(run_one(mixed_port, c.id).await.unwrap_or_else(|_| Value::Null));
    }
    Value::Array(out)
}
