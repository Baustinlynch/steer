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
            Ok(format!(
                "check-ins are on. while you use an ai tool, steer asks \"{QUESTION}\" once at a random moment every {} minutes.\n\
                 your answers help set how steer counts the time between prompts. they only send which button you picked, and they never count as time.\n\
                 if you're away, just let it close by itself. turn it off with: steer checkin off",
                block() / 60
            ))
        }
        Some("off") => {
            let _ = fs::remove_file(flag());
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
}

impl Schedule {
    pub fn new() -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Self { block: 0, at: 0, done: true, seed: nanos ^ u64::from(std::process::id()) | 1 }
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
            self.at = start + self.random() % size;
            self.done = false;
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
    if !schedule.due(now, block()) || !on() || !active(now) || ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        ask_and_send();
        ASKING.store(false, Ordering::SeqCst);
    });
}

/// Whether an AI tool was used recently. `enqueue` notes the time of every event except
/// check-ins, so answering doesn't keep the questions going.
fn active(now: u64) -> bool {
    fs::read_to_string(dir().join("last-activity"))
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .is_some_and(|t| now.saturating_sub(t) <= ACTIVE)
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
    let label = match dialog_tool()? {
        "osascript" => {
            let buttons = BUTTONS.iter().map(|(l, _)| format!("\"{l}\"")).collect::<Vec<_>>().join(", ");
            // No default button, so pressing enter while typing doesn't answer it by accident.
            let script = format!(
                "button returned of (display dialog \"{QUESTION}\" with title \"steer check\" buttons {{{buttons}}} giving up after {WAIT})"
            );
            output(Command::new("osascript").args(["-e", &script]))?
        }
        "powershell" => {
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", &encoded(&windows_dialog())]);
            output(&mut cmd)?
        }
        _ => {
            let mut cmd = Command::new("zenity");
            cmd.args(["--question", "--switch", "--title", "steer check", "--text", QUESTION, "--timeout", &WAIT.to_string()]);
            for (l, _) in BUTTONS {
                cmd.args(["--extra-button", l]);
            }
            output(&mut cmd)?
        }
    };
    BUTTONS.iter().find(|(l, _)| *l == label).map(|(_, code)| *code)
}

fn output(cmd: &mut Command) -> Option<String> {
    let out = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// A small always-on-top window with the three buttons, closing itself after WAIT seconds.
fn windows_dialog() -> String {
    let buttons = BUTTONS.iter().map(|(l, _)| format!("'{l}'")).collect::<Vec<_>>().join(",");
    format!(
        "Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.Text = 'steer check'; $f.TopMost = $true; $f.Width = 540; $f.Height = 140
$f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$q = New-Object Windows.Forms.Label; $q.Text = '{QUESTION}'; $q.AutoSize = $true; $q.Left = 12; $q.Top = 14; $f.Controls.Add($q)
$script:answer = ''
$x = 12
foreach ($t in @({buttons})) {{
  $b = New-Object Windows.Forms.Button; $b.Text = $t; $b.AutoSize = $true; $b.Left = $x; $b.Top = 48
  $b.Add_Click({{ $script:answer = $this.Text; $f.Close() }})
  $f.Controls.Add($b); $x += 170
}}
$timer = New-Object Windows.Forms.Timer; $timer.Interval = {}; $timer.Add_Tick({{ $f.Close() }}); $timer.Start()
[void]$f.ShowDialog()
Write-Output $script:answer
",
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
    fn asks_once_per_block_at_a_random_moment() {
        let mut s = Schedule::new();
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
