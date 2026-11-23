//! Whether someone is at the computer: how long since the keyboard or mouse was last
//! touched, from the system's own idle timer. That's one number of seconds, with no app
//! names and nothing about what was typed. Only read within an hour of using an AI tool.
//!
//! What gets sent, so the server always knows what it knows:
//! - "away", stamped when the keyboard or mouse was last touched, once nobody has for 2
//!   minutes
//! - "back", stamped when someone touches it again, with how long they were away (so a
//!   lost "away" doesn't matter)
//! - "here", every 5 minutes while someone is at it. Without these the server can't tell
//!   "at the computer" from "steer wasn't measuring", and treats a stretch with neither as
//!   unknown.
//!
//! A computer that slept, or a watcher that wasn't running, counts as away from the last
//! check before it.

use crate::live::{self, event, new_id};
use chrono::{TimeZone, Utc};
use serde_json::Value;
use std::process::{Command, Stdio};

/// Nobody touching the computer for this long counts as away.
const AWAY: u64 = 2 * 60;
/// How often the idle timer is read.
const EVERY: u64 = 15;
/// How often "here" is sent while someone is at the computer.
const HERE_EVERY: u64 = 5 * 60;
/// Only while an AI tool was used this recently, so steer isn't watching all evening.
const AROUND_AI: u64 = 60 * 60;
/// Checks further apart than this mean the computer slept or steer wasn't running.
const PAUSED: u64 = 60;

#[derive(Default)]
pub struct Presence {
    away: bool,
    /// When the keyboard or mouse was last touched before going away.
    away_since: u64,
    last_check: u64,
    last_here: u64,
    next: u64,
}

/// One thing to send: what, when (unix seconds), and for "back", how long they were away.
#[derive(Debug, PartialEq)]
struct Change {
    kind: &'static str,
    at: u64,
    away_secs: Option<u64>,
}

/// Called by the watcher every few seconds.
pub fn poll(p: &mut Presence, now: u64) -> Vec<Value> {
    if now < p.next || std::env::var_os("STEER_SANDBOX").is_some() {
        return Vec::new();
    }
    p.next = now + EVERY;
    // Someone who went away still gets "back", whenever that is.
    if !p.away && !live::active_within(now, AROUND_AI) {
        p.last_check = 0;
        return Vec::new();
    }
    let Some(idle) = seconds() else { return Vec::new() };
    step(p, now, idle)
        .into_iter()
        .filter_map(|c| {
            let at = Utc.timestamp_opt(i64::try_from(c.at).ok()?, 0).single()?;
            let mut e = event(new_id(), "presence", "presence", "steer", at, c.kind);
            if let Some(secs) = c.away_secs {
                e["away_secs"] = secs.into();
            }
            Some(e)
        })
        .collect()
}

/// The part of `poll` that doesn't read the clock or the system.
fn step(p: &mut Presence, now: u64, idle: u64) -> Vec<Change> {
    let touched = now.saturating_sub(idle);
    let mut out = Vec::new();
    // Slept, or steer wasn't running: away from the last check, unless they were
    // already away.
    if !p.away && p.last_check > 0 && now.saturating_sub(p.last_check) > PAUSED {
        p.away = true;
        p.away_since = p.last_check;
    }
    p.last_check = now;
    if p.away {
        if idle < AWAY && touched >= p.away_since {
            p.away = false;
            p.last_here = now;
            out.push(Change { kind: "back", at: touched, away_secs: Some(touched - p.away_since) });
        }
    } else if idle >= AWAY {
        p.away = true;
        p.away_since = touched;
        out.push(Change { kind: "away", at: touched, away_secs: None });
    } else if now.saturating_sub(p.last_here) >= HERE_EVERY {
        p.last_here = now;
        out.push(Change { kind: "here", at: now, away_secs: None });
    }
    out
}

/// Seconds since the keyboard or mouse was last touched, if this computer says.
pub fn seconds() -> Option<u64> {
    system_idle()
}

#[cfg(target_os = "macos")]
fn system_idle() -> Option<u64> {
    // The HID system's idle time, in nanoseconds.
    let out = run("ioreg", &["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"])?;
    let line = out.lines().find(|l| l.contains("\"HIDIdleTime\""))?;
    let nanos: u64 = line.rsplit('=').next()?.trim().parse().ok()?;
    Some(nanos / 1_000_000_000)
}

#[cfg(windows)]
fn system_idle() -> Option<u64> {
    #[repr(C)]
    struct LastInputInfo {
        size: u32,
        time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut info = LastInputInfo { size: std::mem::size_of::<LastInputInfo>() as u32, time: 0 };
    // SAFETY: GetLastInputInfo only writes into the struct it's given, whose size is set.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY: no arguments, returns milliseconds since boot.
    let now = unsafe { GetTickCount() };
    Some(u64::from(now.wrapping_sub(info.time)) / 1000)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn system_idle() -> Option<u64> {
    // X11 with xprintidle, else GNOME's idle monitor (which also works on Wayland).
    if let Some(ms) = run("xprintidle", &[]).and_then(|s| s.trim().parse::<u64>().ok()) {
        return Some(ms / 1000);
    }
    let out = run(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.gnome.Mutter.IdleMonitor",
            "--object-path",
            "/org/gnome/Mutter/IdleMonitor/Core",
            "--method",
            "org.gnome.Mutter.IdleMonitor.GetIdletime",
        ],
    )?;
    gnome_millis(&out).map(|ms| ms / 1000)
}

/// GNOME answers like "(uint64 12345,)".
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[cfg_attr(windows, allow(dead_code))]
fn gnome_millis(out: &str) -> Option<u64> {
    out.split_whitespace().nth(1)?.trim_end_matches([',', ')']).parse().ok()
}

#[cfg_attr(windows, allow(dead_code))]
fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(out: Vec<Change>) -> Vec<&'static str> {
        out.into_iter().map(|c| c.kind).collect()
    }

    /// Checks every 15 seconds from `from` to `to`, someone touching the computer at
    /// `touched` (or `idle` seconds before each check if None). Returns what was sent.
    fn run(p: &mut Presence, from: u64, to: u64, touched: Option<u64>, idle: u64) -> Vec<Change> {
        let mut out = Vec::new();
        let mut t = from;
        while t <= to {
            out.extend(step(p, t, touched.map_or(idle, |at| t.saturating_sub(at))));
            t += EVERY;
        }
        out
    }

    #[test]
    fn here_while_at_the_computer_away_and_back_with_how_long() {
        let mut p = Presence::default();
        let t = 1_000_000;
        // Someone typing the whole time: "here" at the start and every 5 minutes.
        let here = run(&mut p, t, t + 600, None, 3);
        assert_eq!(here.iter().map(|c| (c.kind, c.at)).collect::<Vec<_>>(), [("here", t), ("here", t + 300), ("here", t + 600)]);
        // Then nobody touches it after t+600: "away" once, stamped at the last touch, and
        // no "here" while away.
        let away = run(&mut p, t + 615, t + 1500, Some(t + 600), 0);
        assert_eq!(away, [Change { kind: "away", at: t + 600, away_secs: None }]);
        // Back at t+1510: stamped then, with how long they were gone.
        let back = step(&mut p, t + 1515, 5);
        assert_eq!(back, [Change { kind: "back", at: t + 1510, away_secs: Some(910) }]);
        assert_eq!(kinds(run(&mut p, t + 1530, t + 1815, None, 2)), ["here"], "here again 5 minutes after coming back");
    }

    #[test]
    fn a_computer_that_slept_was_away() {
        let mut p = Presence::default();
        let t = 2_000_000;
        step(&mut p, t, 1);
        step(&mut p, t + 15, 1);
        // The lid closes; the next check is an hour later, right after someone opened it.
        let back = step(&mut p, t + 15 + 3600, 2);
        assert_eq!(back, [Change { kind: "back", at: t + 15 + 3598, away_secs: Some(3598) }]);
        // Opened but nobody touches it: still away, and "back" comes when they do.
        let mut q = Presence::default();
        step(&mut q, t, 1);
        assert_eq!(kinds(step(&mut q, t + 3600, 500)), Vec::<&str>::new());
        assert_eq!(step(&mut q, t + 3700, 3), [Change { kind: "back", at: t + 3697, away_secs: Some(3697) }]);
    }

    #[test]
    fn reads_gnomes_answer() {
        assert_eq!(gnome_millis("(uint64 12345,)"), Some(12345));
        assert_eq!(gnome_millis("nope"), None);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn this_mac_has_an_idle_timer() {
        assert!(seconds().is_some());
    }
}
