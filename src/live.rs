//! Live tracking. Claude Code runs `steer hook` when you send a prompt, when a tool
//! runs and when the agent finishes. Each call saves one small event to a queue on
//! this computer and starts `steer flush` in the background to send it, so Claude
//! Code never waits on the network. Prompt text is turned into counts and flags here
//! and never leaves this computer.

use crate::prompt::PromptInfo;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_SERVER: &str = "https://steer.duck.hackclub.app";
const HOOK_EVENTS: [&str; 3] = ["UserPromptSubmit", "PostToolUse", "Stop"];
const BATCH: usize = 500;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// ~/.steer, or $STEER_HOME if set.
fn dir() -> PathBuf {
    std::env::var_os("STEER_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".steer"))
}

// ---------- config ----------

struct Config {
    server: String,
    key: String,
    name: Option<String>,
}

fn load_config() -> Option<Config> {
    let v: Value = serde_json::from_str(&fs::read_to_string(dir().join("config.json")).ok()?).ok()?;
    Some(Config {
        server: v.get("server")?.as_str()?.to_owned(),
        key: v.get("key")?.as_str()?.to_owned(),
        name: v.get("name").and_then(Value::as_str).map(str::to_owned),
    })
}

fn save_config(c: &Config) -> Result<(), String> {
    fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let path = dir().join("config.json");
    let body = json!({ "server": c.server, "key": c.key, "name": c.name });
    fs::write(&path, serde_json::to_string_pretty(&body).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------- talking to the server ----------

fn post(server: &str, path: &str, key: Option<&str>, body: &Value) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
    let mut req = agent
        .post(&format!("{}{}", server.trim_end_matches('/'), path))
        .set("Content-Type", "application/json");
    if let Some(k) = key {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    match req.send_string(&body.to_string()) {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or(text);
            Err(format!("server said {code}: {msg}"))
        }
        Err(e) => Err(format!("couldn't reach {server}: {e}")),
    }
}

// ---------- the hook ----------

/// Called by Claude Code. Never prints and never fails: anything printed on a prompt
/// gets added to the prompt, and Claude Code waits for this to finish.
pub fn hook() {
    let _ = record();
}

fn record() -> Option<()> {
    let mut input = String::new();
    std::io::stdin().take(20_000_000).read_to_string(&mut input).ok()?;
    let v: Value = serde_json::from_str(&input).ok()?;
    let session = v.get("session_id")?.as_str()?;
    let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("");

    let mut e = Map::new();
    e.insert("id".into(), new_id().into());
    e.insert("session".into(), session.into());
    e.insert("project".into(), project_name(cwd).into());
    e.insert("t".into(), Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true).into());

    match v.get("hook_event_name")?.as_str()? {
        "UserPromptSubmit" => {
            let text = v.get("prompt")?.as_str()?.trim();
            let p = PromptInfo::analyze(text, 0);
            let repeat = is_repeat(session, &p);
            e.insert("kind".into(), "prompt".into());
            e.insert("words".into(), p.words.into());
            e.insert("chars".into(), p.chars.into());
            e.insert("images".into(), p.images.into());
            e.insert("specific".into(), p.specific.into());
            e.insert("observation".into(), p.observation.into());
            e.insert("generic".into(), p.generic.into());
            e.insert("repeat".into(), repeat.into());
        }
        "PostToolUse" => {
            e.insert("kind".into(), "tool".into());
            e.insert("tool".into(), v.get("tool_name").and_then(Value::as_str).unwrap_or("").into());
        }
        "Stop" => {
            e.insert("kind".into(), "stop".into());
        }
        _ => return None,
    }

    fs::create_dir_all(dir()).ok()?;
    let mut queue = OpenOptions::new().create(true).append(true).open(dir().join("queue.jsonl")).ok()?;
    queue.write_all(format!("{}\n", Value::Object(e)).as_bytes()).ok()?;
    if !flushing() {
        spawn_flush();
    }
    Some(())
}

fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}", nanos, std::process::id())
}

/// Folder name of the git repo the session is in, or of the folder itself.
fn project_name(cwd: &str) -> String {
    let start = Path::new(cwd);
    let mut d = Some(start);
    while let Some(p) = d {
        if p.join(".git").exists() {
            return p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        }
        d = p.parent();
    }
    start.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "unknown".into())
}

/// Compares the prompt to the previous one in the same session. Only word hashes of the
/// last prompt per session are kept, in ~/.steer/last-prompts.json.
fn is_repeat(session: &str, p: &PromptInfo) -> bool {
    is_repeat_in(&dir().join("last-prompts.json"), session, p)
}

const SAVED_SESSIONS: usize = 50;

fn is_repeat_in(path: &Path, session: &str, p: &PromptInfo) -> bool {
    let mut saved: Map<String, Value> = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let previous = saved.get(session).and_then(saved_hashes);
    let repeat = previous.is_some_and(|prev| p.words >= 3 && p.similarity_to(&prev) >= 0.6);

    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let hashes: Vec<Value> = p.word_hashes().iter().map(|h| (*h).into()).collect();
    saved.insert(session.to_owned(), json!({ "t": now, "h": hashes }));

    // Keep the sessions used most recently. serde_json's Map is sorted by key, not by
    // when things were added, so the oldest has to be found by its time. The current
    // session is never dropped.
    while saved.len() > SAVED_SESSIONS {
        let oldest = saved
            .iter()
            .filter(|(k, _)| k.as_str() != session)
            .min_by_key(|(_, v)| v.get("t").and_then(Value::as_u64).unwrap_or(0))
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                saved.remove(&k);
            }
            None => break,
        }
    }
    let _ = fs::write(path, Value::Object(saved).to_string());
    repeat
}

/// Reads a saved entry: {"t": secs, "h": [hashes]}, or just [hashes] from older versions.
fn saved_hashes(v: &Value) -> Option<HashSet<u64>> {
    let list = v.get("h").unwrap_or(v).as_array()?;
    Some(list.iter().filter_map(Value::as_u64).collect())
}

// ---------- sending ----------

fn lock_path() -> PathBuf {
    dir().join("flush.lock")
}

/// True if another `steer flush` is running. A lock older than a minute is from a
/// flush that died and gets ignored.
fn flushing() -> bool {
    fs::metadata(lock_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(60))
}

fn spawn_flush() {
    let Ok(exe) = std::env::current_exe() else { return };
    let mut cmd = Command::new(exe);
    cmd.arg("flush").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd.spawn();
}

/// Sends everything in the queue. Events that can't be sent stay queued for next time.
/// Returns how many were sent, or an error if sending stopped early.
pub fn flush() -> Result<usize, String> {
    let Some(config) = load_config() else { return Err("not signed in, run steer signup or steer login".into()) };
    if flushing() {
        return Ok(0);
    }
    fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    fs::write(lock_path(), std::process::id().to_string()).map_err(|e| e.to_string())?;
    let result = send_all(&config);
    let _ = fs::remove_file(lock_path());
    result
}

fn send_all(config: &Config) -> Result<usize, String> {
    let mut sent = 0;
    loop {
        // Move the queue aside first, so hooks can keep adding to a fresh one meanwhile.
        let queue = dir().join("queue.jsonl");
        if queue.exists() {
            let _ = fs::rename(&queue, dir().join(format!("sending-{}.jsonl", new_id())));
        }
        let mut pending: Vec<PathBuf> = fs::read_dir(dir())
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("sending-")))
            .collect();
        if pending.is_empty() {
            return Ok(sent);
        }
        pending.sort();
        for file in pending {
            let events: Vec<Value> = fs::read_to_string(&file)
                .map_err(|e| e.to_string())?
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            for chunk in events.chunks(BATCH) {
                post(&config.server, "/api/events", Some(&config.key), &json!({ "events": chunk }))?;
                sent += chunk.len();
            }
            let _ = fs::remove_file(&file);
        }
        let _ = fs::write(lock_path(), std::process::id().to_string());
    }
}

fn queued() -> usize {
    fs::read_dir(dir())
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    n == "queue.jsonl" || n.starts_with("sending-")
                })
                .filter_map(|p| fs::read_to_string(p).ok())
                .map(|s| s.lines().count())
                .sum()
        })
        .unwrap_or(0)
}

// ---------- Claude Code settings ----------

fn claude_settings() -> PathBuf {
    home().join(".claude").join("settings.json")
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|h| {
                h.get("command").and_then(Value::as_str).is_some_and(|c| c.contains("steer") && c.ends_with(" hook"))
            })
        })
}

/// Adds (or with `remove`, takes out) the steer hooks in Claude Code's settings.json.
/// Everything else in the file is left alone, and the first time it's changed a backup
/// is saved next to it.
fn setup(settings: &Path, remove: bool) -> Result<String, String> {
    let original = if settings.exists() {
        Some(fs::read_to_string(settings).map_err(|e| format!("couldn't read {}: {e}", settings.display()))?)
    } else {
        None
    };
    let mut root: Value = match &original {
        Some(text) if !text.trim().is_empty() => serde_json::from_str(text)
            .map_err(|e| format!("{} isn't valid JSON ({e}), so it wasn't changed", settings.display()))?,
        _ => json!({}),
    };
    let obj = root.as_object_mut().ok_or("settings.json isn't a JSON object, so it wasn't changed")?;

    let command = if remove {
        String::new()
    } else {
        // Copy the binary somewhere stable so the hooks keep working if this one moves.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bin = dir().join("bin");
        fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
        let target = bin.join(if cfg!(windows) { "steer.exe" } else { "steer" });
        if exe != target {
            // Copy next to it, then swap it in, so a hook that's running right now never
            // sees a half-written file.
            let fresh = bin.join(format!("steer-{}.new", std::process::id()));
            fs::copy(&exe, &fresh).map_err(|e| format!("couldn't copy steer to {}: {e}", bin.display()))?;
            fs::rename(&fresh, &target).map_err(|e| format!("couldn't put steer in {}: {e}", target.display()))?;
        }
        format!("\"{}\" hook", target.display())
    };

    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" in settings.json isn't an object, so it wasn't changed")?;
    let mut changed = 0;
    for event in HOOK_EVENTS {
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        let Some(groups) = groups.as_array_mut() else { continue };
        let before = groups.len();
        groups.retain(|g| !is_ours(g));
        if remove {
            changed += before - groups.len();
        } else {
            let mut group = json!({ "hooks": [{ "type": "command", "command": command }] });
            if event == "PostToolUse" {
                group["matcher"] = "*".into();
            }
            groups.push(group);
            changed += 1;
        }
    }
    hooks.retain(|_, v| !v.as_array().is_some_and(|a| a.is_empty()));
    if hooks.is_empty() {
        obj.remove("hooks");
    }

    if let Some(text) = &original {
        let backup = settings.with_extension("json.steer-backup");
        if !backup.exists() {
            fs::write(&backup, text).map_err(|e| e.to_string())?;
        }
    }
    if let Some(parent) = settings.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(settings, serde_json::to_string_pretty(&root).unwrap() + "\n").map_err(|e| e.to_string())?;
    Ok(if remove {
        format!("took {changed} steer hooks out of {}", settings.display())
    } else {
        format!("added steer hooks for {} to {}", HOOK_EVENTS.join(", "), settings.display())
    })
}

fn hooks_installed(settings: &Path) -> bool {
    fs::read_to_string(settings)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("hooks").cloned())
        .and_then(|h| h.as_object().cloned())
        .is_some_and(|h| {
            HOOK_EVENTS
                .iter()
                .all(|e| h.get(*e).and_then(Value::as_array).is_some_and(|gs| gs.iter().any(is_ours)))
        })
}

// ---------- commands ----------

pub const HELP: &str = "live tracking:
  steer signup NAME [--server URL]   make an account and save its key
  steer login KEY [--server URL]     use an account you already have
  steer setup [--settings FILE]      add the steer hooks to Claude Code
  steer setup --remove               take them out again
  steer status                       show what's set up and what's waiting to send
  steer flush                        send waiting events now";

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn positional(args: &[String]) -> Option<&String> {
    let mut skip = false;
    for a in args.iter().skip(1) {
        if skip {
            skip = false;
        } else if a == "--server" || a == "--settings" {
            skip = true;
        } else if !a.starts_with("--") {
            return Some(a);
        }
    }
    None
}

/// Runs a live tracking command and returns the exit code.
pub fn command(args: &[String]) -> i32 {
    let result = match args[0].as_str() {
        "signup" => signup(args),
        "login" => login(args),
        "setup" => {
            let settings = flag_value(args, "--settings").map(PathBuf::from).unwrap_or_else(claude_settings);
            setup(&settings, args.iter().any(|a| a == "--remove"))
        }
        "status" => Ok(status()),
        "flush" => flush().map(|n| format!("sent {n} events")),
        _ => Err(format!("unknown command {}", args[0])),
    };
    match result {
        Ok(msg) => {
            println!("{msg}");
            0
        }
        Err(e) => {
            eprintln!("steer: {e}");
            1
        }
    }
}

fn signup(args: &[String]) -> Result<String, String> {
    let name = positional(args).ok_or("usage: steer signup NAME")?;
    let server = flag_value(args, "--server").unwrap_or_else(|| DEFAULT_SERVER.into());
    let resp = post(&server, "/api/signup", None, &json!({ "name": name }))?;
    let key = resp.get("key").and_then(Value::as_str).ok_or("server didn't send a key")?;
    let name = resp.get("name").and_then(Value::as_str).unwrap_or(name).to_owned();
    save_config(&Config { server: server.clone(), key: key.into(), name: Some(name.clone()) })?;
    Ok(format!(
        "signed up as {name}. your key is saved in {}\nyour page: {}/u/{name}\nnext: steer setup",
        dir().join("config.json").display(),
        server.trim_end_matches('/')
    ))
}

fn login(args: &[String]) -> Result<String, String> {
    let key = positional(args).ok_or("usage: steer login KEY")?;
    let server = flag_value(args, "--server").unwrap_or_else(|| DEFAULT_SERVER.into());
    post(&server, "/api/events", Some(key), &json!({ "events": [] }))?;
    save_config(&Config { server, key: key.clone(), name: None })?;
    Ok("key works, saved. next: steer setup".into())
}

fn status() -> String {
    let settings = claude_settings();
    let mut out = String::new();
    match load_config() {
        Some(c) => {
            let who = c.name.as_deref().unwrap_or("(logged in with a key)");
            out += &format!("account: {who} on {}\n", c.server);
            if let Some(n) = &c.name {
                out += &format!("page: {}/u/{n}\n", c.server.trim_end_matches('/'));
            }
        }
        None => out += "account: none yet, run steer signup NAME\n",
    }
    out += &format!(
        "claude code hooks: {}\n",
        if hooks_installed(&settings) { "on" } else { "off, run steer setup" }
    );
    out += &format!("waiting to send: {} events", queued());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeat_detection_keeps_the_current_session() {
        let path = std::env::temp_dir().join(format!("steer-last-{}.json", new_id()));
        let filler = PromptInfo::analyze("add a settings page with a dark mode toggle", 0);
        for i in 0..SAVED_SESSIONS + 10 {
            is_repeat_in(&path, &format!("zzz-{i:03}"), &filler);
        }
        // "aaa" sorts before every other session, which used to get it thrown out.
        let first = PromptInfo::analyze("make the snake move faster when it eats food", 0);
        let again = PromptInfo::analyze("make the snake move faster when it eats food please", 0);
        assert!(!is_repeat_in(&path, "aaa", &first));
        assert!(is_repeat_in(&path, "aaa", &again));

        let saved: Map<String, Value> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.len(), SAVED_SESSIONS);
        assert!(saved.contains_key("aaa"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn old_saved_format_still_reads() {
        assert_eq!(saved_hashes(&json!([1, 2, 3])).unwrap().len(), 3);
        assert_eq!(saved_hashes(&json!({ "t": 5, "h": [4, 5] })).unwrap().len(), 2);
    }

    #[test]
    fn setup_adds_and_removes_only_its_own_hooks() {
        let tmp = std::env::temp_dir().join(format!("steer-test-{}", new_id()));
        fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("STEER_HOME", tmp.join("steer"));
        let settings = tmp.join("settings.json");
        let theirs = json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] }
        });
        fs::write(&settings, theirs.to_string()).unwrap();

        setup(&settings, false).unwrap();
        setup(&settings, false).unwrap(); // running twice doesn't add twice
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "*");
        assert!(hooks_installed(&settings));
        assert!(settings.with_extension("json.steer-backup").exists());

        setup(&settings, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert!(v["hooks"].get("UserPromptSubmit").is_none());
        assert!(!hooks_installed(&settings));
        let _ = fs::remove_dir_all(&tmp);
    }
}
