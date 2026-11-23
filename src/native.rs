//! The other end of steer's browser extension (native messaging): Chrome starts steer
//! with the extension's origin as an argument and talks to it over stdin and stdout,
//! each message a 4-byte length and then JSON. The extension counts prompts on ChatGPT
//! and Claude in the browser itself and only ever sends counts here, which get queued
//! like every other tool's events.
//!
//! Which project browser chats count toward: the one picked in the extension's popup,
//! else the repo an AI tool was used in most recently, else "browser".

use crate::live::{self, dir, enqueue, event, load_config, new_id};
use chrono::Utc;
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{Read, Write};

/// What Chrome registers steer under, in the manifests `steer setup` writes.
pub const HOST: &str = "app.steer.native";
/// The extension's id, fixed by the public key in extension/manifest.json.
pub const EXTENSION_ID: &str = "badjomjdmajniieefpgbnglnocamhmck";
const VIAS: [&str; 2] = ["chatgpt", "claude-ai"];
/// Chrome caps messages to a host at 4 GB, steer's are tiny.
const MAX_MESSAGE: u32 = 1 << 20;

/// True if Chrome (or Edge, Brave...) started steer as the extension's host.
pub fn started_by_browser(args: &[String]) -> bool {
    args.iter().any(|a| a.starts_with("chrome-extension://"))
}

/// Answers messages until the browser closes the connection.
pub fn run() -> i32 {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    while let Some(message) = read(&mut input) {
        let answer = handle(&message);
        if write(&mut output, &answer).is_err() {
            break;
        }
    }
    0
}

fn read(input: &mut impl Read) -> Option<Value> {
    let mut len = [0u8; 4];
    input.read_exact(&mut len).ok()?;
    let len = u32::from_ne_bytes(len);
    if len > MAX_MESSAGE {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    input.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn write(output: &mut impl Write, v: &Value) -> std::io::Result<()> {
    let bytes = v.to_string().into_bytes();
    output.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

pub(crate) fn handle(m: &Value) -> Value {
    match m["kind"].as_str() {
        Some("projects") => {
            let config = load_config();
            json!({
                "signed_in": config.is_some(),
                "user": config.and_then(|c| c.name),
                "current": project(),
                "recent": recent_projects(),
            })
        }
        Some("set-project") => {
            let name = m["name"].as_str().unwrap_or_default();
            if name.is_empty() || name.len() > 100 || name.contains(['\n', '\r', '/', '\\']) {
                return json!({ "ok": false });
            }
            let _ = fs::create_dir_all(dir());
            json!({ "ok": fs::write(dir().join("browser-project"), name).is_ok() })
        }
        Some(kind @ ("prompt" | "stop")) => {
            let Some(via) = m["via"].as_str().filter(|v| VIAS.contains(v)) else { return json!({ "ok": false }) };
            let session: String = m["session"].as_str().unwrap_or("browser").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(80).collect();
            let session = format!("{via}:{session}");
            let mut e = event(new_id(), &session, &project(), via, Utc::now(), kind);
            if kind == "prompt" {
                let count = |k: &str, max: u64| m[k].as_u64().unwrap_or(0).min(max);
                let words = count("words", 100_000);
                e["words"] = words.into();
                e["chars"] = count("chars", 1_000_000).max(words).into();
                e["images"] = count("images", 100).into();
                e["specific"] = count("specific", words + 2).into();
                for flag in ["observation", "generic", "repeat"] {
                    e[flag] = m[flag].as_bool().unwrap_or(false).into();
                }
            }
            let ok = enqueue(&[e]).is_some();
            if ok && !live::flushing() {
                live::spawn_flush();
            }
            json!({ "ok": ok })
        }
        _ => json!({ "ok": false, "error": "unknown message" }),
    }
}

/// The project browser chats count toward right now.
fn project() -> String {
    if let Ok(name) = fs::read_to_string(dir().join("browser-project")) {
        let name = name.trim();
        if !name.is_empty() {
            return name.to_owned();
        }
    }
    recent_projects().into_iter().next().unwrap_or_else(|| "browser".into())
}

/// Projects an AI tool was used in, most recent first (from ~/.steer/repos.json).
fn recent_projects() -> Vec<String> {
    let repos: Map<String, Value> = fs::read_to_string(dir().join("repos.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let mut list: Vec<(i64, String)> = repos.values().filter_map(|v| Some((v["used"].as_i64()?, v["name"].as_str()?.to_owned()))).collect();
    list.sort_by_key(|(used, _)| -used);
    let mut names: Vec<String> = Vec::new();
    for (_, name) in list {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.truncate(10);
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_go_both_ways() {
        let mut buf = Vec::new();
        write(&mut buf, &json!({ "kind": "projects" })).unwrap();
        let back = read(&mut buf.as_slice()).unwrap();
        assert_eq!(back["kind"], "projects");
        // A length that says more than steer would ever get is refused.
        let mut huge = (MAX_MESSAGE + 1).to_ne_bytes().to_vec();
        huge.extend_from_slice(b"{}");
        assert!(read(&mut huge.as_slice()).is_none());
    }

    #[test]
    fn only_known_sites_and_sane_names() {
        live::use_temp_home();
        assert_eq!(handle(&json!({ "kind": "prompt", "via": "evil", "session": "x" }))["ok"], false);
        assert_eq!(handle(&json!({ "kind": "set-project", "name": "../../etc" }))["ok"], false);
        assert_eq!(handle(&json!({ "kind": "nope" }))["ok"], false);
        assert!(started_by_browser(&["chrome-extension://badjomjdmajniieefpgbnglnocamhmck/".into()]));
        assert!(!started_by_browser(&["watch".into()]));
    }
}

/// Registers steer with the Chromium browsers on this computer, so the extension can
/// start it (or with `remove`, takes that out again). Only touches browsers that are
/// installed.
pub fn install(remove: bool) -> String {
    let manifest = json!({
        "name": HOST,
        "description": "steer: counts from the steer browser extension",
        "path": live::bin_path(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    let mut done = Vec::new();
    if cfg!(windows) {
        if std::env::var_os("STEER_SANDBOX").is_some() {
            return "left the browser registry alone (STEER_SANDBOX is set)".into();
        }
        let file = dir().join("native").join(format!("{HOST}.json"));
        let browsers = [
            ("chrome", r"Software\Google\Chrome"),
            ("edge", r"Software\Microsoft\Edge"),
            ("brave", r"Software\BraveSoftware\Brave-Browser"),
            ("chromium", r"Software\Chromium"),
            ("vivaldi", r"Software\Vivaldi"),
        ];
        if !remove {
            let _ = fs::create_dir_all(file.parent().unwrap());
            if fs::write(&file, manifest.to_string()).is_err() {
                return "couldn't set up the browser extension".into();
            }
        }
        for (name, base) in browsers {
            let key = format!(r"HKCU\{base}\NativeMessagingHosts\{HOST}");
            let ok = if remove {
                std::process::Command::new("reg").args(["delete", &key, "/f"]).output().is_ok_and(|o| o.status.success())
            } else {
                let exists = std::process::Command::new("reg").args(["query", &format!(r"HKCU\{base}")]).output().is_ok_and(|o| o.status.success());
                exists
                    && std::process::Command::new("reg")
                        .args(["add", &key, "/ve", "/t", "REG_SZ", "/d"])
                        .arg(&file)
                        .args(["/f"])
                        .output()
                        .is_ok_and(|o| o.status.success())
            };
            if ok {
                done.push(name);
            }
        }
        if remove {
            let _ = fs::remove_file(&file);
        }
    } else {
        let home = live::home();
        let browsers: Vec<(&str, std::path::PathBuf)> = if cfg!(target_os = "macos") {
            let support = home.join("Library").join("Application Support");
            vec![
                ("chrome", support.join("Google").join("Chrome")),
                ("chrome beta", support.join("Google").join("Chrome Beta")),
                ("chromium", support.join("Chromium")),
                ("brave", support.join("BraveSoftware").join("Brave-Browser")),
                ("edge", support.join("Microsoft Edge")),
                ("arc", support.join("Arc").join("User Data")),
                ("vivaldi", support.join("Vivaldi")),
            ]
        } else {
            let config = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".config"));
            vec![
                ("chrome", config.join("google-chrome")),
                ("chromium", config.join("chromium")),
                ("brave", config.join("BraveSoftware").join("Brave-Browser")),
                ("edge", config.join("microsoft-edge")),
                ("vivaldi", config.join("vivaldi")),
            ]
        };
        for (name, base) in browsers {
            if !base.exists() {
                continue;
            }
            let file = base.join("NativeMessagingHosts").join(format!("{HOST}.json"));
            let ok = if remove {
                fs::remove_file(&file).is_ok()
            } else {
                fs::create_dir_all(file.parent().unwrap()).is_ok() && fs::write(&file, manifest.to_string()).is_ok()
            };
            if ok {
                done.push(name);
            }
        }
    }
    match (remove, done.is_empty()) {
        (false, true) => "no chrome, edge or brave found, so the browser extension isn't set up".into(),
        (false, false) => format!("the steer browser extension can talk to steer in: {}", done.join(", ")),
        (true, _) => "took steer out of the browsers".into(),
    }
}
