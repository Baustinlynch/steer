//! Evidence from your projects: saves that changed the code, and commits. The watcher
//! looks every 30 seconds, only in git repos an AI tool was used in during the last 2
//! hours, and only sends counts: how many files changed since it last looked, or a
//! commit's hash. File names and contents never leave the computer.
//!
//! A change only counts as yours once the agent has been quiet for a minute, so the
//! agent's own edits don't count. Going back to a state of the files seen in the last
//! hour (undoing a change, or flipping a file back and forth) doesn't count either, and
//! touching a file without changing it is nothing.

use crate::live::{dir, event, new_id};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const EVERY: Duration = Duration::from_secs(30);
/// Same as EVIDENCE_REACH in web/steer.js: evidence further than this from AI use
/// wouldn't join an AI session anyway.
const REACH: i64 = 2 * 3600;
/// A change this soon after the agent's last step is the agent's.
const AGENT_QUIET: i64 = 60;
/// A new HEAD counts as a commit only if it was made this recently, so checking out an
/// old branch isn't one.
const COMMIT_FRESH: i64 = 600;
const MAX_REPOS: usize = 5;
const MAX_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 1_000_000;
/// How long a state of the files is remembered.
const REMEMBER: i64 = 3600;
/// Repos not used with an AI tool for this long are dropped from repos.json.
const FORGET: i64 = 7 * 86400;

fn repos_path() -> PathBuf {
    dir().join("repos.json")
}

fn read_repos() -> Map<String, Value> {
    fs::read_to_string(repos_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Called with every batch of events that gets queued: remembers which git repos the AI
/// tools were used in, and when the agent last did something there. Stored in
/// ~/.steer/repos.json, which never leaves the computer.
pub(crate) fn note(events: &[Value]) {
    let roots = crate::live::known_roots();
    if roots.is_empty() {
        return;
    }
    let mut saved = read_repos();
    if !note_into(&mut saved, &roots, events, Utc::now().timestamp()) {
        return;
    }
    let _ = fs::create_dir_all(dir());
    // Written next to it and moved over, so the watcher never reads half a file.
    let tmp = dir().join(format!("repos.json.{}", std::process::id()));
    if fs::write(&tmp, Value::Object(saved).to_string()).is_ok() {
        let _ = fs::rename(&tmp, repos_path());
    }
}

/// The part of `note` that doesn't touch files. Returns whether anything changed.
fn note_into(saved: &mut Map<String, Value>, roots: &[(String, PathBuf)], events: &[Value], now: i64) -> bool {
    let mut changed = false;
    for e in events {
        // steer's own events (evidence, check-ins) aren't AI use.
        if e["via"] == "steer" {
            continue;
        }
        let Some(project) = e["project"].as_str() else { continue };
        let Some((_, root)) = roots.iter().find(|(n, _)| n == project) else { continue };
        let t = e["t"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp()).unwrap_or(now);
        let entry = saved
            .entry(root.to_string_lossy().into_owned())
            .or_insert_with(|| json!({ "name": project, "used": 0, "agent": 0 }));
        if entry["used"].as_i64().unwrap_or(0) < t {
            entry["used"] = t.into();
            entry["name"] = project.into();
        }
        if matches!(e["kind"].as_str(), Some("tool" | "stop")) && entry["agent"].as_i64().unwrap_or(0) < t {
            entry["agent"] = t.into();
        }
        changed = true;
    }
    if changed {
        saved.retain(|_, v| now - v["used"].as_i64().unwrap_or(0) < FORGET);
    }
    changed
}

/// A repo being looked at: where it is, its project name, and when the agent last did
/// something in it.
pub(crate) struct Active {
    pub(crate) root: PathBuf,
    pub(crate) name: String,
    pub(crate) agent: i64,
}

struct Repo {
    head: String,
    files: HashMap<String, u64>,
    seen: VecDeque<(u64, i64)>,
}

#[derive(Default)]
pub struct Watch {
    last: Option<Instant>,
    repos: HashMap<PathBuf, Repo>,
}

/// For the watcher loop: every 30 seconds, the evidence events to queue.
pub fn poll(w: &mut Watch) -> Vec<Value> {
    if w.last.is_some_and(|l| l.elapsed() < EVERY) {
        return Vec::new();
    }
    w.last = Some(Instant::now());
    let now = Utc::now().timestamp();
    let mut active: Vec<(i64, Active)> = read_repos()
        .into_iter()
        .filter_map(|(root, v)| {
            let used = v["used"].as_i64()?;
            (now - used <= REACH).then(|| {
                let name = v["name"].as_str().unwrap_or("unknown").to_owned();
                (used, Active { root: PathBuf::from(root), name, agent: v["agent"].as_i64().unwrap_or(0) })
            })
        })
        .collect();
    active.sort_by_key(|(used, _)| -used);
    active.truncate(MAX_REPOS);
    let active: Vec<Active> = active.into_iter().map(|(_, a)| a).collect();
    look(w, &active, now)
}

/// Compares each repo with how it was last time. The first look at a repo only notes how
/// it is, since what happened before that can't be told apart.
pub(crate) fn look(w: &mut Watch, active: &[Active], now: i64) -> Vec<Value> {
    w.repos.retain(|root, _| active.iter().any(|a| &a.root == root));
    let mut out = Vec::new();
    for a in active {
        let Some(files) = changed_files(&a.root) else { continue };
        let head = git(&a.root, &["rev-parse", "HEAD"]).unwrap_or_default();
        let state = fingerprint(&files);
        let agent_busy = now - a.agent < AGENT_QUIET;
        let Some(r) = w.repos.get_mut(&a.root) else {
            w.repos.insert(a.root.clone(), Repo { head, files, seen: VecDeque::from([(state, now)]) });
            continue;
        };
        if head != r.head && !head.is_empty() {
            if !agent_busy && fresh_commit(&a.root, now) {
                let mut e = event(new_id(), "evidence", &a.name, "steer", Utc::now(), "commit");
                e["hash"] = head.clone().into();
                out.push(e);
            }
        } else if files != r.files && !agent_busy && !r.seen.iter().any(|(s, _)| *s == state) {
            let count = files.iter().filter(|(p, h)| r.files.get(*p) != Some(h)).count() + r.files.keys().filter(|p| !files.contains_key(*p)).count();
            let mut e = event(new_id(), "evidence", &a.name, "steer", Utc::now(), "save");
            e["count"] = count.clamp(1, 10_000).into();
            out.push(e);
        }
        r.head = head;
        r.files = files;
        r.seen.push_back((state, now));
        while r.seen.front().is_some_and(|(_, t)| now - t > REMEMBER) || r.seen.len() > 500 {
            r.seen.pop_front();
        }
    }
    out
}

/// Every file that differs from the last commit, or isn't in git yet (and isn't
/// ignored), with a hash of what's in it now. None if git can't read the repo.
fn changed_files(root: &Path) -> Option<HashMap<String, u64>> {
    // --no-optional-locks: a plain `git status` can rewrite the index, which would get
    // in the way of the person's own git commands.
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let mut files = HashMap::new();
    for entry in out.stdout.split(|b| *b == 0) {
        if entry.len() < 4 || files.len() >= MAX_FILES {
            continue;
        }
        let path = String::from_utf8_lossy(&entry[3..]).into_owned();
        let full = root.join(&path);
        let hash = match fs::metadata(&full) {
            Ok(m) if m.is_file() && m.len() <= MAX_FILE_BYTES => fs::read(&full).map(|b| hash_of(&b)).unwrap_or(1),
            // Too big to read every 30 seconds: its size stands in for what's in it.
            Ok(m) => hash_of(&m.len().to_le_bytes()),
            Err(_) => 0, // deleted
        };
        files.insert(path, hash);
    }
    Some(files)
}

fn fingerprint(files: &HashMap<String, u64>) -> u64 {
    let mut list: Vec<(&String, &u64)> = files.iter().collect();
    list.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    list.hash(&mut h);
    h.finish()
}

fn hash_of(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// True if HEAD was committed in the last 10 minutes, by the person this repo is set up
/// for (when it says who that is).
fn fresh_commit(root: &Path, now: i64) -> bool {
    let Some(info) = git(root, &["log", "-1", "--format=%ct %ae", "HEAD"]) else { return false };
    let mut parts = info.splitn(2, ' ');
    let when = parts.next().and_then(|t| t.parse::<i64>().ok()).unwrap_or(0);
    let author = parts.next().unwrap_or_default();
    let me = git(root, &["config", "user.email"]).unwrap_or_default();
    now - when <= COMMIT_FRESH && (me.is_empty() || me.eq_ignore_ascii_case(author))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(root: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(root).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn only_real_changes_by_you_count() {
        let root = std::env::temp_dir().join(format!("steer-evidence-{}", new_id()));
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-q"]);
        run(&root, &["config", "user.email", "me@example.com"]);
        run(&root, &["config", "user.name", "me"]);
        fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-qm", "start"]);

        let mut w = Watch::default();
        let now = Utc::now().timestamp();
        let quiet = |agent: i64| [Active { root: root.clone(), name: "game".into(), agent }];
        let kinds = |events: Vec<Value>| events.iter().map(|e| e["kind"].as_str().unwrap().to_owned()).collect::<Vec<_>>();

        // The first look only notes how things are.
        assert!(look(&mut w, &quiet(0), now).is_empty());
        // You change a file: a save, of one file.
        fs::write(root.join("main.rs"), "fn main() { println!(\"hi\"); }\n").unwrap();
        let e = look(&mut w, &quiet(0), now + 30);
        assert_eq!(kinds(e.clone()), ["save"]);
        assert_eq!(e[0]["count"], 1);
        assert_eq!(e[0]["via"], "steer");
        // Nothing changed: nothing.
        assert!(look(&mut w, &quiet(0), now + 60).is_empty());
        // Saving it again unchanged (a new modified time, same contents): nothing.
        fs::write(root.join("main.rs"), "fn main() { println!(\"hi\"); }\n").unwrap();
        assert!(look(&mut w, &quiet(0), now + 90).is_empty());
        // Undoing it goes back to a state seen before: nothing.
        fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        assert!(look(&mut w, &quiet(0), now + 120).is_empty());
        // The agent edits while it's running: not yours.
        fs::write(root.join("enemy.rs"), "struct Enemy;\n").unwrap();
        assert!(look(&mut w, &quiet(now + 140), now + 150).is_empty());
        // A new file you write after it stopped: a save.
        fs::write(root.join("boss.rs"), "struct Boss;\n").unwrap();
        assert_eq!(kinds(look(&mut w, &quiet(now + 140), now + 240)), ["save"]);
        // You commit: a commit with its hash.
        run(&root, &["add", "."]);
        run(&root, &["commit", "-qm", "boss"]);
        let e = look(&mut w, &quiet(now + 140), now + 270);
        assert_eq!(kinds(e.clone()), ["commit"]);
        let head = git(&root, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(e[0]["hash"], head.as_str());
        // A repo that's no longer active is forgotten.
        assert!(look(&mut w, &[], now + 300).is_empty());
        assert!(w.repos.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn queued_events_say_which_repos_to_watch() {
        let root = std::env::temp_dir().join(format!("steer-repo-{}", new_id()));
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let name = crate::live::project_name(&root.join("src").to_string_lossy());
        let roots: Vec<_> = crate::live::known_roots().into_iter().filter(|(n, _)| n == &name).collect();
        assert_eq!(roots, [(name.clone(), root.clone())], "project_name remembers the repo it found");
        let t = Utc::now();
        let mut saved = Map::new();
        // A repo nobody used an AI tool in for over a week is dropped.
        saved.insert("/old".into(), json!({ "name": "old", "used": t.timestamp() - 8 * 86400, "agent": 0 }));
        let events = [
            event(new_id(), "s", &name, "claude-code", t, "prompt"),
            event(new_id(), "s", &name, "claude-code", t + chrono::Duration::seconds(5), "tool"),
            // steer's own events don't count as using an AI tool.
            event(new_id(), "evidence", &name, "steer", t + chrono::Duration::seconds(50), "save"),
        ];
        assert!(note_into(&mut saved, &roots, &events, t.timestamp() + 60));
        assert!(!saved.contains_key("/old"));
        let entry = &saved[&root.to_string_lossy().into_owned()];
        assert_eq!(entry["name"], name.as_str());
        assert_eq!(entry["used"], t.timestamp() + 5);
        assert_eq!(entry["agent"], t.timestamp() + 5);
        let _ = fs::remove_dir_all(&root);
    }
}
