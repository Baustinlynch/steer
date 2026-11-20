//! Reads Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl).
//! Prompt text is analyzed in memory and dropped; nothing here is written or sent anywhere.

use crate::model::{Event, EventKind, Session};
use crate::prompt::PromptInfo;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub fn default_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// Top-level session files only. Subagent logs live in nested folders and are skipped,
/// since they're the agent talking to itself.
pub fn find_session_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(dirs) = fs::read_dir(root) else { return out };
    for dir in dirs.flatten() {
        let Ok(entries) = fs::read_dir(dir.path()) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

pub fn parse_session(path: &Path) -> Option<Session> {
    let reader = BufReader::new(File::open(path).ok()?);
    let mut events = Vec::new();
    let mut cwd = None;
    let mut custom_title = None;
    let mut ai_title = None;

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or_default();
        match ty {
            "custom-title" => {
                custom_title = str_field(&v, "customTitle");
                continue;
            }
            "ai-title" => {
                ai_title = str_field(&v, "aiTitle");
                continue;
            }
            "user" | "assistant" => {}
            _ => continue,
        }
        if flag(&v, "isSidechain") {
            continue;
        }
        let Some(t) = timestamp(&v) else { continue };
        if cwd.is_none() {
            cwd = str_field(&v, "cwd");
        }
        let event = if ty == "assistant" { assistant_event(&v, t) } else { user_event(&v, t) };
        if let Some(mut e) = event {
            e.id = v.get("uuid").and_then(Value::as_str).map(hash_id);
            events.push(e);
        }
    }

    if events.is_empty() {
        return None;
    }
    events.sort_by_key(|e| e.t);
    Some(Session { cwd, title: custom_title.or(ai_title), events })
}

fn assistant_event(v: &Value, t: DateTime<Utc>) -> Option<Event> {
    if flag(v, "isApiErrorMessage") {
        return None;
    }
    let tools = v
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|b| str_field(b, "name"))
                .collect()
        })
        .unwrap_or_default();
    Some(Event { id: None, t, kind: EventKind::Agent { tools } })
}

fn user_event(v: &Value, t: DateTime<Utc>) -> Option<Event> {
    // Entries the harness injects rather than the human typing them.
    if ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "isVirtual"]
        .iter()
        .any(|f| flag(v, f))
    {
        return None;
    }
    let content = v.pointer("/message/content")?;

    // Tool results come back to the agent as "user" entries. They're agent activity,
    // unless the human rejected the call, which is a steering decision.
    if let Some(blocks) = content.as_array() {
        if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
            let kind = if v.get("toolDenialKind").and_then(Value::as_str) == Some("user-rejected") {
                EventKind::Rejected
            } else {
                EventKind::Agent { tools: Vec::new() }
            };
            return Some(Event { id: None, t, kind });
        }
    }

    // Newer logs mark who started a turn. Anything not from the human is skipped
    // (background task notices, messages from other agents, synthetic turns).
    if let Some(kind) = v.pointer("/origin/kind").and_then(Value::as_str) {
        if kind != "human" {
            return None;
        }
    }
    if let Some(origin) = v.get("turnOrigin").and_then(Value::as_str) {
        if origin != "human" {
            return None;
        }
    }
    if v.get("promptSource").and_then(Value::as_str) == Some("system") {
        return None;
    }

    let (raw, images) = extract_text(content);
    let stripped = strip_tag(&raw, "system-reminder");
    let text = stripped.trim();
    const SKIP: [&str; 6] = [
        "<task-notification>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<bash-stdout>",
        "<bash-stderr>",
        "Caveat:",
    ];
    if SKIP.iter().any(|p| text.starts_with(p)) {
        return None;
    }
    let kind = if text.starts_with("[Request interrupted by user") {
        EventKind::Interrupt
    } else if text.starts_with("<bash-input>") {
        EventKind::Shell
    } else if text.starts_with("<command-name>") {
        EventKind::Command
    } else if text.is_empty() && images == 0 {
        return None;
    } else {
        EventKind::Prompt(PromptInfo::analyze(text, images))
    };
    Some(Event { id: None, t, kind })
}

fn extract_text(content: &Value) -> (String, usize) {
    match content {
        Value::String(s) => (s.clone(), 0),
        Value::Array(blocks) => {
            let mut text = String::new();
            let mut images = 0;
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(s) = b.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(s);
                        }
                    }
                    Some("image") => images += 1,
                    _ => {}
                }
            }
            (text, images)
        }
        _ => (String::new(), 0),
    }
}

fn strip_tag(s: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find(&close) {
            Some(end) => &rest[start + end + close.len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn hash_id(id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut h);
    h.finish()
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn timestamp(v: &Value) -> Option<DateTime<Utc>> {
    let s = v.get("timestamp").and_then(Value::as_str)?;
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}
