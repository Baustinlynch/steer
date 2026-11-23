//! `steer checkin`: asks "what are you doing right now?" at random moments while you
//! work, so steer's credit curve can be fitted to real answers instead of guessed. Off
//! unless you turn it on. Each answer is sent like other events: which button you
//! picked and when, nothing else, and it never counts as time.

use crate::live::{self, dir, enqueue};
use chrono::Utc;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// One question per block, at a random moment in it. Random moments are what make the
/// answers add up to an unbiased curve.
const BLOCK: u64 = 20 * 60;
/// Only ask if steer saw an AI tool in use this recently, so it doesn't ask all evening.
const ACTIVE: u64 = 60 * 60;
/// No answer after this counts as "none", which usually means away.
const WAIT: u64 = 90;
/// People who installed before install asked about check-ins get asked once by the
/// watcher, only while they're clearly at the computer, and at most 3 times a day apart
/// if they never click either button.
const OFFER_ACTIVE: u64 = 10 * 60;
const OFFER_TRIES: u32 = 3;
const DAY: u64 = 24 * 60 * 60;
const OFFER_BUTTONS: [&str; 2] = ["no thanks", "yes, turn them on"];

const QUESTION: &str = "what are you doing right now?";
/// The buttons, and what each one is sent as.
const BUTTONS: [(&str, &str); 3] =
    [("something else", "other"), ("my project, on my own", "project"), ("my project, with the ai", "project-ai")];

fn flag() -> PathBuf {
    dir().join("checkin")
}

pub fn on() -> bool {
    flag().exists()
}

/// True if this computer can show the question (on linux that needs zenity).
pub fn can_ask() -> bool {
    dialog_tool().is_some()
}

/// How often it asks, for install's question.
pub fn every_minutes() -> u64 {
    block() / 60
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Seconds per block. STEER_CHECKIN_BLOCK makes it shorter for trying it out.
fn block() -> u64 {
    std::env::var("STEER_CHECKIN_BLOCK").ok().and_then(|s| s.parse().ok()).filter(|&b| b >= 10).unwrap_or(BLOCK)
}

/// `steer checkin on|off|now|status`
pub fn command(args: &[String]) -> Result<String, String> {
    match args.get(1).map(String::as_str) {
        Some("on") => {
            if dialog_tool().is_none() {
                return Err("check-ins need zenity on linux (sudo apt install zenity or similar)".into());
            }
            fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
            fs::write(flag(), "").map_err(|e| e.to_string())?;
            mark_offered();
            Ok(format!(
                "check-ins are on. while you use an ai tool, steer asks \"{QUESTION}\" once at a random moment every {} minutes.\n\
                 your answers help set how steer counts the time between prompts. they only send which button you picked, and they never count as time.\n\
                 if you're away, just let it close by itself. turn it off with: steer checkin off",
                block() / 60
            ))
        }
        Some("off") => {
            let _ = fs::remove_file(flag());
            // Turned off on purpose, so the watcher never asks to turn them back on.
            mark_offered();
            Ok("check-ins are off".into())
        }
        Some("now") => {
            let answer = ask_and_send();
            Ok(format!("answer: {answer}"))
        }
        _ => Ok(if on() { "check-ins are on (steer checkin off to stop)" } else { "check-ins are off (steer checkin on to help)" }.into()),
    }
}

/// When the current block's question is due. Kept by the watcher between ticks.
pub struct Schedule {
    block: u64,
    at: u64,
    done: bool,
    seed: u64,
    /// When this watcher started. A block whose moment came before it isn't asked late,
    /// or every restart (an update, a login) would ask right away, which isn't a random
    /// moment, and could ask twice in a block.
    started: u64,
}

impl Schedule {
    pub fn new() -> Self {
        Self::starting_at(now())
    }

    fn starting_at(started: u64) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Self { block: 0, at: 0, done: true, seed: nanos ^ u64::from(std::process::id()) | 1, started }
    }

    fn random(&mut self) -> u64 {
        // xorshift, plenty for picking a moment
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        self.seed
    }

    /// True once per block, at that block's random moment.
    fn due(&mut self, now: u64, size: u64) -> bool {
        let start = now / size * size;
        if start != self.block {
            self.block = start;
            // Not in the block's last minute, or the watcher (which looks every few
            // seconds) could miss it and skip the block.
            self.at = start + self.random() % size.saturating_sub(60).max(1);
            self.done = self.at < self.started;
        }
        if !self.done && now >= self.at {
            self.done = true;
            return true;
        }
        false
    }
}

static ASKING: AtomicBool = AtomicBool::new(false);

/// Called by the watcher every few seconds. Asks in the background when it's time.
pub fn tick(schedule: &mut Schedule) {
    let now = now();
    if !on() {
        offer(now);
        return;
    }
    if !schedule.due(now, block()) || !active(now, ACTIVE) || asked_in_block(now, block()) || ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Kept in a file, so a watcher that restarts in this block doesn't ask again.
    let _ = fs::write(last_asked_file(), now.to_string());
    std::thread::spawn(|| {
        ask_and_send();
        ASKING.store(false, Ordering::SeqCst);
    });
}

fn last_asked_file() -> PathBuf {
    dir().join("checkin-last")
}

/// Whether the question was already asked in the block `now` is in, by this watcher or
/// one that ran before it.
fn asked_in_block(now: u64, size: u64) -> bool {
    fs::read_to_string(last_asked_file())
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .is_some_and(|t| t >= now / size * size)
}

fn active(now: u64, within: u64) -> bool {
    live::active_within(now, within)
}

// ---------- asking once whether to turn check-ins on ----------

fn offered_file() -> PathBuf {
    dir().join("checkin-offered")
}

#[derive(Debug, PartialEq)]
enum Offered {
    Not,
    /// Someone clicked a button (here or in install), or turned check-ins on or off.
    Answered,
    /// Asked this many times, the last at this time, and nobody clicked.
    Tries(u32, u64),
}

fn offered() -> Offered {
    let Ok(s) = fs::read_to_string(offered_file()) else { return Offered::Not };
    let mut parts = s.split_whitespace();
    match (parts.next(), parts.next().and_then(|n| n.parse().ok()), parts.next().and_then(|t| t.parse().ok())) {
        (Some("tries"), Some(n), Some(t)) => Offered::Tries(n, t),
        // "answered", or anything strange: don't ask.
        _ => Offered::Answered,
    }
}

fn offer_due(state: &Offered, now: u64) -> bool {
    match state {
        Offered::Not => true,
        Offered::Answered => false,
        Offered::Tries(n, last) => *n < OFFER_TRIES && now.saturating_sub(*last) >= DAY,
    }
}

/// So the watcher never asks: install asked already, or check-ins were turned on or off.
pub fn mark_offered() {
    let _ = fs::create_dir_all(dir());
    let _ = fs::write(offered_file(), "answered");
}

/// Asks whether to turn check-ins on, if it's time to. In the background, like the
/// questions themselves.
fn offer(now: u64) {
    if std::env::var_os("STEER_SANDBOX").is_some() || !active(now, OFFER_ACTIVE) {
        return;
    }
    let state = offered();
    if !offer_due(&state, now) || !can_ask() || ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let tries = if let Offered::Tries(n, _) = state { n + 1 } else { 1 };
    // Written first, so a crash or a closed laptop can't make it ask over and over.
    let _ = fs::create_dir_all(dir());
    let _ = fs::write(offered_file(), format!("tries {tries} {now}"));
    std::thread::spawn(|| {
        let text = format!(
            "want to help check that steer's numbers are right? while you use an ai tool, steer would ask \"{QUESTION}\" once every {} minutes, with 3 buttons. it closes by itself after {WAIT} seconds, and answers never count as time. you can stop it anytime with: steer checkin off",
            every_minutes()
        );
        match dialog(&text, &OFFER_BUTTONS).as_deref() {
            Some(b) if b == OFFER_BUTTONS[1] => {
                let _ = command(&["checkin".into(), "on".into()]);
            }
            Some(_) => mark_offered(),
            None => {}
        }
        ASKING.store(false, Ordering::SeqCst);
    });
}

fn ask_and_send() -> &'static str {
    let asked = Utc::now();
    let started = Instant::now();
    let answer = ask().unwrap_or("none");
    let mut e = live::event(live::new_id(), "checkin", "checkin", "steer", asked, "checkin");
    e["answer"] = answer.into();
    e["answered_after"] = started.elapsed().as_secs().into();
    let _ = enqueue(&[e]);
    let _ = live::flush();
    answer
}

/// Which program shows the question on this computer.
fn dialog_tool() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("osascript")
    } else if cfg!(windows) {
        Some("powershell")
    } else {
        Command::new("zenity").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().ok().filter(|s| s.success()).map(|_| "zenity")
    }
}

/// Shows the question and returns the answer's code, or None if nobody clicked.
fn ask() -> Option<&'static str> {
    let labels: Vec<&str> = BUTTONS.iter().map(|(l, _)| *l).collect();
    let clicked = dialog(QUESTION, &labels)?;
    BUTTONS.iter().find(|(l, _)| *l == clicked).map(|(_, code)| *code)
}

/// A small window with `text` and `buttons`, closing itself after WAIT seconds. Returns
/// the button clicked, or None if nobody clicked.
fn dialog(text: &str, buttons: &[&str]) -> Option<String> {
    let clicked = match dialog_tool()? {
        "osascript" => {
            let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
            let list = buttons.iter().map(|b| quote(b)).collect::<Vec<_>>().join(", ");
            // No default button, so pressing enter while typing doesn't answer it by accident.
            let script =
                format!("button returned of (display dialog {} with title \"steer check\" buttons {{{list}}} giving up after {WAIT})", quote(text));
            output(Command::new("osascript").args(["-e", &script]))?
        }
        "powershell" => {
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", &encoded(&windows_dialog(text, buttons))]);
            output(&mut cmd)?
        }
        _ => {
            // zenity's text is markup.
            let text = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            let mut cmd = Command::new("zenity");
            cmd.args(["--question", "--switch", "--title", "steer check", "--text", &text, "--timeout", &WAIT.to_string()]);
            for b in buttons {
                cmd.args(["--extra-button", b]);
            }
            output(&mut cmd)?
        }
    };
    buttons.iter().find(|b| **b == clicked).map(|b| (*b).to_owned())
}

fn output(cmd: &mut Command) -> Option<String> {
    let out = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// The Windows window: always on top, the text wrapped, a button each.
fn windows_dialog(text: &str, buttons: &[&str]) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let list = buttons.iter().map(|b| quote(b)).collect::<Vec<_>>().join(",");
    format!(
        "Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object Windows.Forms.Form
$f.Text = 'steer check'; $f.TopMost = $true; $f.Width = 540
$f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$q = New-Object Windows.Forms.Label; $q.Text = {}; $q.Left = 12; $q.Top = 14
$q.AutoSize = $true; $q.MaximumSize = New-Object Drawing.Size(500, 0); $f.Controls.Add($q)
$y = $q.Top + $q.GetPreferredSize((New-Object Drawing.Size(500, 0))).Height + 14
$script:answer = ''
$x = 12
foreach ($t in @({list})) {{
  $b = New-Object Windows.Forms.Button; $b.Text = $t; $b.AutoSize = $true; $b.Left = $x; $b.Top = $y
  $b.Add_Click({{ $script:answer = $this.Text; $f.Close() }})
  $f.Controls.Add($b); $x += 170
}}
$f.Height = $y + 80
$timer = New-Object Windows.Forms.Timer; $timer.Interval = {}; $timer.Add_Tick({{ $f.Close() }}); $timer.Start()
[void]$f.ShowDialog()
Write-Output $script:answer
",
        quote(text),
        WAIT * 1000
    )
}

/// PowerShell's -EncodedCommand: the script as UTF-16LE, in base64.
fn encoded(script: &str) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_to_turn_check_ins_on_at_most_three_times_a_day_apart() {
        live::use_temp_home();
        fs::create_dir_all(dir()).unwrap();
        let _ = fs::remove_file(offered_file());
        assert_eq!(offered(), Offered::Not);
        assert!(offer_due(&Offered::Not, 1000));
        fs::write(offered_file(), "tries 1 1000").unwrap();
        assert_eq!(offered(), Offered::Tries(1, 1000));
        assert!(!offer_due(&offered(), 1000 + DAY - 1), "not twice in a day");
        assert!(offer_due(&offered(), 1000 + DAY));
        assert!(!offer_due(&Offered::Tries(OFFER_TRIES, 0), 10 * DAY), "and not more than 3 times");
        mark_offered();
        assert_eq!(offered(), Offered::Answered);
        assert!(!offer_due(&offered(), 10 * DAY), "never again once someone answers");
        fs::write(offered_file(), "garbled").unwrap();
        assert!(!offer_due(&offered(), 10 * DAY), "a file steer can't read means don't ask");
    }

    #[test]
    fn dialogs_quote_their_text() {
        let script = windows_dialog("steer's \"numbers\"", &["no thanks", "yes"]);
        assert!(script.contains("$q.Text = 'steer''s \"numbers\"'"));
        assert!(script.contains("@('no thanks','yes')"));
    }

    #[test]
    fn a_watcher_that_starts_mid_block_doesnt_ask_late() {
        // Started 10 minutes into a block: if that block's moment was before the start,
        // it waits for the next block instead of asking right away.
        let start = 20_000 * BLOCK;
        let mut skipped = 0;
        for _ in 0..50 {
            let mut s = Schedule::starting_at(start + 600);
            let mut asked = Vec::new();
            for t in (start + 600..start + 2 * BLOCK).step_by(5) {
                if s.due(t, BLOCK) {
                    asked.push(t);
                }
            }
            assert!(asked.iter().filter(|&&t| t >= start + BLOCK).count() == 1, "the next block is asked normally");
            if asked.len() == 1 {
                skipped += 1;
            }
        }
        assert!(skipped > 0, "about half the time the first block's moment had already passed");
    }

    #[test]
    fn asked_once_per_block_even_across_restarts() {
        crate::live::use_temp_home();
        fs::create_dir_all(dir()).unwrap();
        let block_start = 30_000 * BLOCK;
        fs::write(last_asked_file(), (block_start + 100).to_string()).unwrap();
        assert!(asked_in_block(block_start + 500, BLOCK), "a new watcher in the same block doesn't ask again");
        assert!(!asked_in_block(block_start + BLOCK + 1, BLOCK), "the next block can be asked");
    }

    #[test]
    fn asks_once_per_block_at_a_random_moment() {
        let mut s = Schedule::starting_at(0);
        let mut asked = Vec::new();
        for t in (10_000 * BLOCK..10_000 * BLOCK + 6 * BLOCK).step_by(5) {
            if s.due(t, BLOCK) {
                asked.push(t);
            }
        }
        assert_eq!(asked.len(), 6, "once in each of 6 blocks");
        for (i, t) in asked.iter().enumerate() {
            let start = 10_000 * BLOCK + i as u64 * BLOCK;
            assert!((start..start + BLOCK).contains(t));
        }
        // Not all at the same spot in their block.
        let spots: std::collections::HashSet<u64> = asked.iter().map(|t| t % BLOCK / 60).collect();
        assert!(spots.len() > 1);
    }

    #[test]
    fn powershell_script_is_base64_utf16() {
        assert_eq!(encoded("hi"), "aABpAA==");
        assert_eq!(encoded("abc"), "YQBiAGMA");
    }
}
