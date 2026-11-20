//! Builds the HTML report. Prompt text never gets here.

use crate::analyze::{
    SessionReport, Turn, TurnKind, Why, LOOP_GAP, LOW_INFO_CAP, REVIEW_CAP, TESTED_CAP, TOOL_GROUPS, WATCH_WINDOW,
};
use chrono::{DateTime, Local, NaiveDate, Utc};
use std::fmt::Write;

pub struct Project {
    pub name: String,
    pub sessions: Vec<SessionReport>,
}

impl Project {
    pub fn new(name: String) -> Self {
        Self { name, sessions: Vec::new() }
    }
    pub fn human_secs(&self) -> i64 {
        self.sessions.iter().map(SessionReport::human_secs).sum()
    }
    pub fn agent_secs(&self) -> i64 {
        self.sessions.iter().map(SessionReport::agent_secs).sum()
    }
    pub fn flagged_secs(&self) -> i64 {
        self.sessions.iter().map(SessionReport::flagged_secs).sum()
    }
}

pub struct Options {
    pub window: String,
    pub hide_titles: bool,
}

pub fn fmt_dur(secs: i64) -> String {
    let secs = secs.max(0);
    let (h, m) = (secs / 3600, (secs % 3600) / 60);
    if h > 0 {
        format!("{h}h {m:02}m")
    } else if m > 0 {
        format!("{m}m")
    } else if secs > 0 {
        format!("{secs}s")
    } else {
        "0m".into()
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn local(t: DateTime<Utc>) -> DateTime<Local> {
    t.with_timezone(&Local)
}

fn pct(part: i64, whole: i64) -> f64 {
    if whole <= 0 {
        0.0
    } else {
        (part as f64 / whole as f64 * 100.0).clamp(0.0, 100.0)
    }
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

pub fn render(projects: &[Project], opts: &Options) -> String {
    let human: i64 = projects.iter().map(Project::human_secs).sum();
    let agent: i64 = projects.iter().map(Project::agent_secs).sum();
    let flagged: i64 = projects.iter().map(Project::flagged_secs).sum();
    let sessions: usize = projects.iter().map(|p| p.sessions.len()).sum();

    let mut h = String::with_capacity(256 * 1024);
    h.push_str(HEAD);
    let _ = write!(
        h,
        r#"<h1>steer report</h1>
<p>{sessions} in {projects}, {window}. Made from your Claude Code logs on this computer. Prompt text isn't included.</p>
<table class="totals">
<tr><th>Your time</th><td>{you}</td></tr>
<tr><th>Agent time</th><td>{agent}</td></tr>
<tr><th>1/3 rule</th><td>{rule}</td></tr>
<tr><th>Dark flow (not counted)</th><td>{flow}</td></tr>
</table>
"#,
        sessions = plural(sessions, "session"),
        projects = plural(projects.len(), "project"),
        window = esc(&opts.window),
        you = fmt_dur(human),
        agent = fmt_dur(agent),
        rule = fmt_dur(agent / 3),
        flow = fmt_dur(flagged),
    );

    let scale = projects.iter().map(|p| p.human_secs().max(p.agent_secs())).max().unwrap_or(1).max(1);
    h.push_str(
        r#"<h2>Projects</h2>
<div class="scroll"><table class="list">
<tr><th>Project</th><th class="r">Sessions</th><th class="r">Your time</th><th class="r">Agent time</th><th class="r">1/3 rule</th><th class="bars">Black: you, gray: agent</th></tr>
"#,
    );
    for p in projects {
        let (ph, pa) = (p.human_secs(), p.agent_secs());
        let _ = write!(
            h,
            r#"<tr><td>{name}</td><td class="r">{n}</td><td class="r">{you}</td><td class="r">{agent}</td><td class="r">{rule}</td><td class="bars"><div class="bar you" style="width:{wy:.2}%"></div><div class="bar agent" style="width:{wa:.2}%"></div></td></tr>
"#,
            name = esc(&p.name),
            n = p.sessions.len(),
            you = fmt_dur(ph),
            agent = fmt_dur(pa),
            rule = fmt_dur(pa / 3),
            wy = pct(ph, scale),
            wa = pct(pa, scale),
        );
    }
    h.push_str("</table></div>\n");

    h.push_str("<h2>Sessions</h2>\n<p class=\"muted\">In each bar, black is your time, gray is agent time and red is dark flow. Breaks are left out.</p>\n");
    for p in projects {
        let _ = write!(
            h,
            "<h3>{name} <span class=\"muted\">(you {you}, agent {agent})</span></h3>\n",
            name = esc(&p.name),
            you = fmt_dur(p.human_secs()),
            agent = fmt_dur(p.agent_secs()),
        );
        for s in &p.sessions {
            render_session(&mut h, s, opts);
        }
    }

    h.push_str(HOW);
    h.push_str("</main>\n</body>\n</html>\n");
    h
}

fn render_session(h: &mut String, s: &SessionReport, opts: &Options) {
    let title = match (&s.title, opts.hide_titles) {
        (Some(t), false) => esc(t),
        _ => "Session".into(),
    };
    let _ = write!(
        h,
        "<details><summary>{when} &nbsp; {title} &nbsp; <span class=\"muted\">you {you}, agent {agent}, {actions}</span></summary>\n",
        when = local(s.start).format("%b %-d %H:%M"),
        you = fmt_dur(s.human_secs()),
        agent = fmt_dur(s.agent_secs()),
        actions = plural(s.turns.len(), "action"),
    );

    h.push_str("<div class=\"strip\">");
    for t in &s.turns {
        let total = t.human_secs + t.flagged_secs + t.agent_secs;
        if total <= 0 {
            continue;
        }
        let (class, you) = if t.dark_flow { ("h flow", t.human_secs + t.flagged_secs) } else { ("h", t.human_secs) };
        let _ = write!(
            h,
            r#"<span class="blk" style="flex-grow:{total}"><i class="{class}" style="flex-grow:{you}"></i><i class="a" style="flex-grow:{agent}"></i></span>"#,
            agent = t.agent_secs,
        );
    }
    h.push_str("</div>\n");

    h.push_str("<div class=\"scroll\"><table class=\"list turns\">\n<tr><th>Time</th><th>Action</th><th>Notes</th><th class=\"r\">Your time</th><th class=\"r\">Agent time after</th><th>Agent did</th></tr>\n");
    let start_day = local(s.start).date_naive();
    for t in &s.turns {
        render_turn(h, t, start_day);
    }
    h.push_str("</table></div>\n</details>\n");
}

fn render_turn(h: &mut String, t: &Turn, start_day: NaiveDate) {
    let lt = local(t.t);
    let when = if lt.date_naive() == start_day {
        lt.format("%H:%M").to_string()
    } else {
        lt.format("%b %-d %H:%M").to_string()
    };
    let action = match t.kind {
        TurnKind::Prompt => format!("Prompt ({})", plural(t.words, "word")),
        TurnKind::Interrupt => "Stopped agent".into(),
        TurnKind::Shell => "Ran command".into(),
        TurnKind::Command => "Slash command".into(),
        TurnKind::Rejected => "Rejected tool call".into(),
    };

    let (notes, mut more) = note(t);
    if t.commits > 0 {
        let _ = write!(more, "\n{} before your next action.", plural(t.commits, "commit"));
    }

    let you = if t.dark_flow && t.flagged_secs > 0 {
        format!("{} (was {})", fmt_dur(t.human_secs), fmt_dur(t.human_secs + t.flagged_secs))
    } else {
        fmt_dur(t.human_secs)
    };
    let agent = if t.agent_secs > 0 { fmt_dur(t.agent_secs) } else { String::new() };
    let did: Vec<String> = TOOL_GROUPS
        .iter()
        .zip(t.tools.iter())
        .filter(|(_, n)| **n > 0)
        .map(|(g, n)| plural(*n, g))
        .collect();

    let _ = write!(
        h,
        "<tr{row}><td>{when}</td><td>{action}</td><td title=\"{more}\">{notes}</td><td class=\"r\">{you}</td><td class=\"r\">{agent}</td><td>{did}</td></tr>\n",
        row = if t.dark_flow { " class=\"flow\"" } else { "" },
        more = esc(&more),
        did = did.join(", "),
    );
}

/// Seconds for the hover text: "40s", "9m 12s", "1h 05m".
fn exact(secs: i64) -> String {
    let s = secs.max(0);
    match (s / 3600, s % 3600 / 60, s % 60) {
        (0, 0, s) => format!("{s}s"),
        (0, m, 0) => format!("{m}m"),
        (0, m, s) => format!("{m}m {s}s"),
        (h, m, _) => format!("{h}h {m:02}m"),
    }
}

/// Like fmt_dur, but 0 is "0s".
fn ago(secs: i64) -> String {
    if secs <= 0 {
        "0s".into()
    } else {
        fmt_dur(secs)
    }
}

/// What a prompt tag means, in words.
fn tag_words(tag: &str) -> &str {
    match tag {
        "screenshot" => "has a screenshot",
        "reported a result" => "says what happened",
        "ran a command first" => "you ran a command first",
        "specific" => "names files or code",
        "low info" => "short, like \"continue\"",
        "repeat" => "almost the same as your last prompt",
        other => other,
    }
}

/// How the prompt shows you tested something, if it does. Same as `tested` in analyze.
fn tested_how(t: &Turn) -> Option<&'static str> {
    if t.tags.contains(&"screenshot") {
        Some("you sent a screenshot")
    } else if t.tags.contains(&"reported a result") {
        Some("you said what happened")
    } else if t.tags.contains(&"ran a command first") {
        Some("you ran a command first")
    } else {
        None
    }
}

/// Why a turn got the time it did: a short line for the notes column (HTML), and more
/// detail for hovering over it (plain text). web/steer.js has the same words in turnNote.
pub fn note(t: &Turn) -> (String, String) {
    // Time before dark flow cut it down.
    let base = t.human_secs + t.flagged_secs;
    let since = if t.from_agent { "after the agent stopped" } else { "after your last action" };
    let short_prompt = t.tags.contains(&"low info");
    let tested = tested_how(t);
    let cap_why = |cap: i64| match (cap, tested) {
        (TESTED_CAP, Some(how)) => format!(" it's {} because {how}.", exact(cap)),
        (LOW_INFO_CAP, _) => format!(" it's {} because it's a short prompt like \"continue\".", exact(cap)),
        _ => String::new(),
    };

    let (mut short, mut long) = match (t.kind, t.why) {
        (TurnKind::Prompt, Why::First) => (
            "first prompt, just typing time".to_string(),
            format!("nothing before it to measure from, so only typing time counts ({}).", exact(t.typed)),
        ),
        (_, Why::First) => (
            format!("first action, counts {}", ago(base)),
            format!("nothing before it to measure from, so it gets a flat {}.", exact(base)),
        ),
        (_, Why::Break { gap, cap, back }) => {
            let came = format!("your prompt came {} {since}", exact(gap));
            if base == t.typed + back {
                let short = match tested {
                    Some(_) => format!("back after a break, tested: {} + typing", ago(back)),
                    None => format!("back after a break: {} + typing", ago(back)),
                };
                let long = format!(
                    "{came}, over the {} max, so it counts as a break. we can't tell when you came back, so {} to catch up plus typing ({}) counts.{}",
                    exact(cap),
                    exact(back),
                    exact(t.typed),
                    tested.map_or(String::new(), |how| format!(
                        " the max is {} and catch-up is {} because {how}.",
                        exact(cap),
                        exact(back)
                    )),
                );
                (short, long)
            } else if base > t.typed {
                let short = if short_prompt {
                    format!("short prompt after a break, capped at {}", ago(cap))
                } else {
                    format!("back after a break, capped at {}", ago(cap))
                };
                (short, format!("{came}, over the {} max.{}", exact(cap), cap_why(cap)))
            } else {
                (
                    "typing time, longer than the max".to_string(),
                    format!("{came}, over the {} max, but typing it takes about {}.", exact(cap), exact(t.typed)),
                )
            }
        }
        (_, Why::Reply { gap, watch, .. }) if watch > 0 => (
            format!("replied {} {since} + {} watching", ago(gap), ago(watch)),
            format!(
                "you replied {} {since}. that's within {}, so you were probably watching it work, and {} of its run time counts too.",
                exact(gap),
                exact(WATCH_WINDOW),
                exact(watch),
            ),
        ),
        (_, Why::Reply { gap, cap, .. }) => {
            let short = if tested.is_some() && gap > REVIEW_CAP {
                format!("tested, replied {} {since}", ago(gap))
            } else {
                format!("replied {} {since}", ago(gap))
            };
            let long = if t.from_agent {
                format!("the {} between the agent stopping and your prompt counts, up to {}.", exact(gap), exact(cap))
            } else {
                format!(
                    "the agent didn't do anything after your last action, so the {} since then counts, up to {}.",
                    exact(gap),
                    exact(cap)
                )
            };
            (short, long + &cap_why(cap))
        }
        (_, Why::Typing { gap, watch }) => (
            "typing time, longer than the wait".to_string(),
            format!(
                "you replied {} {since}{}, but typing it takes about {}, so typing time counts.",
                exact(gap),
                if watch > 0 { format!(" (+{} watching)", exact(watch)) } else { String::new() },
                exact(t.typed),
            ),
        ),
        (_, Why::Wall { wall }) => (
            format!("{} since your last action", ago(wall)),
            "it can't count more than the time since your last action.".to_string(),
        ),
        (kind, Why::Clamped { secs, min, max }) => {
            let (since, from) = match (kind, t.from_agent) {
                (TurnKind::Rejected, true) => ("after the agent asked", "since the agent asked"),
                (_, true) => (since, "since the agent stopped"),
                (_, false) => (since, "since your last action"),
            };
            let short = if secs > max {
                format!("{} {since}, capped at {}", exact(secs), ago(max))
            } else if secs < min {
                format!("under {}, counts as {}", ago(min), ago(min))
            } else {
                format!("{} {since}", ago(secs))
            };
            let range = format!("{} to {}", exact(min), exact(max));
            let long = match kind {
                TurnKind::Interrupt => {
                    format!("stopping the agent means you were watching it, so the time {from} counts, {range}.")
                }
                TurnKind::Shell => format!(
                    "you ran a command yourself, so the time {from} counts, {range}. your next prompt counts as tested."
                ),
                TurnKind::Command => format!("slash commands count the time {from}, {range}."),
                TurnKind::Rejected => format!("you read what the agent wanted to do and said no. the time {from} counts, {range}."),
                TurnKind::Prompt => format!("the time {from} counts, {range}."),
            };
            (short, long)
        }
    };

    if t.dark_flow {
        let was = format!(" it would have been {}: {short}.", exact(base));
        short = format!(
            "<span class=\"red\">dark flow</span>: {} prompt in a run of {}, typing only",
            if short_prompt { "short" } else { "repeat" },
            t.run
        );
        long = format!(
            "{} short or repeat prompts in a row, each within {} of the last, and none show testing. that looks like hitting retry, so only typing time counts ({}).{}",
            t.run,
            exact(LOOP_GAP),
            exact(t.typed),
            if t.flagged_secs > 0 { was } else { String::new() },
        );
    }
    if t.kind == TurnKind::Prompt && !t.tags.is_empty() {
        let words: Vec<&str> = t.tags.iter().map(|s| tag_words(s)).collect();
        let _ = write!(long, "\nprompt: {}", words.join(", "));
    }
    (short, long)
}

const HEAD: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>steer report</title>
<style>
body{margin:0;background:#fff;color:#000;font:14px/1.45 Arial,Helvetica,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}
h2{font-size:17px;margin:28px 0 8px;padding-bottom:2px;border-bottom:1px solid #000}
h3{font-size:15px;margin:20px 0 6px}
p{margin:6px 0}
.muted{color:#555;font-weight:normal}
.red{color:#c00}
table{border-collapse:collapse}
th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#f0f0f0}
.totals td{text-align:right;min-width:90px}
.list{width:100%}
.r{text-align:right;white-space:nowrap}
.bars{width:28%}
.bar{height:6px;margin:2px 0;min-width:1px}
.bar.you{background:#000}
.bar.agent{background:#bbb}
details{border:1px solid #ccc;margin:4px 0;padding:4px 6px}
summary{cursor:pointer}
.strip{display:flex;height:10px;margin:6px 0;border:1px solid #ccc}
.blk{display:flex;flex-basis:0;min-width:1px;border-right:1px solid #fff}
.blk i{display:block;flex-basis:0;min-width:0}
.blk i.h{background:#000}
.blk i.h.flow{background:#c00}
.blk i.a{background:#bbb}
.turns{font-size:13px;margin-bottom:4px}
tr.flow td{background:#fff0f0}
.scroll{overflow-x:auto}
ul{padding-left:20px}
li{margin:3px 0}
</style>
</head>
<body>
<main>
"#;

const HOW: &str = r#"<h2>How it counts</h2>
<ul>
<li>Your time comes from things you do: prompts, stopping the agent, rejecting a tool call, running a command.</li>
<li>Time between the agent finishing and your next prompt counts, up to 10 min. Up to 20 min if the prompt has a screenshot, describes what happened, or you ran a command first. Up to 2 min for short prompts like "continue" (3 words or less with no file names, numbers or code).</li>
<li>A longer gap is a break. Then only 2 min plus typing time counts (5 min if you tested something). Short prompts get 2 min at most.</li>
<li>If you reply within 2 min of the agent finishing, up to 2 min of agent time counts too.</li>
<li>Typing time is guessed from how long the prompt is, about 48 words a minute, between 5s and 5 min.</li>
<li>Stopping the agent counts the time since your last action, up to 5 min. A command you run counts up to 5 min, a slash command up to 30s and a rejected tool call up to 1 min.</li>
<li>Agent time never counts as your time.</li>
<li>3 or more short or repeated prompts in a row, each within 15 min of the last and without testing, is dark flow. Only typing time counts for those.</li>
<li>If a session was resumed or forked, the copied messages only count once.</li>
<li>The notes say why each row got its time. Hover over a note for the numbers.</li>
<li>Prompts are only used for word counts and notes. The text isn't saved.</li>
<li>1/3 rule is agent time divided by 3, which is roughly what reviewers do now with Hackatime AI time.</li>
</ul>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analyze::analyze;
    use crate::model::{Event, EventKind, Session};
    use crate::prompt::PromptInfo;

    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + secs, 0).unwrap()
    }
    fn prompt(secs: i64, text: &str) -> Event {
        Event { id: None, t: at(secs), kind: EventKind::Prompt(PromptInfo::analyze(text, 0)) }
    }
    fn agent(secs: i64) -> Event {
        Event { id: None, t: at(secs), kind: EventKind::Agent { tools: vec!["Edit".into()] } }
    }
    fn notes(events: Vec<Event>) -> Vec<String> {
        let r = analyze(&Session { cwd: None, title: None, events }, &[]);
        r.turns.iter().map(|t| note(t).0).collect()
    }

    #[test]
    fn says_how_long_you_took_to_reply() {
        let n = notes(vec![
            prompt(0, "add a pause menu with resume and quit buttons"),
            agent(60),
            prompt(60 + 9 * 60 + 30, "make the quit button go back to the title screen"),
        ]);
        assert_eq!(n[0], "first prompt, just typing time");
        assert_eq!(n[1], "replied 9m after the agent stopped");
    }

    #[test]
    fn says_when_watching_counts() {
        let n = notes(vec![
            prompt(0, "add a pause menu with resume and quit buttons"),
            agent(90),
            prompt(130, "now make it pause the music too"),
        ]);
        assert_eq!(n[1], "replied 40s after the agent stopped + 1m watching");
    }

    #[test]
    fn says_why_a_break_is_short() {
        let n = notes(vec![
            prompt(0, "make the enemies spawn in waves"),
            agent(120),
            prompt(120 + 3600, "continue"),
            agent(3800),
            prompt(3800 + 3600, "now add a boss on wave 5 with more health"),
        ]);
        assert_eq!(n[1], "short prompt after a break, capped at 2m");
        assert_eq!(n[2], "back after a break: 2m + typing");
    }

    #[test]
    fn says_dark_flow_only_counts_typing() {
        let mut ev = vec![prompt(0, "build a snake game in the browser")];
        for (i, text) in ["fix it", "continue", "fix it"].iter().enumerate() {
            let s = 120 + i as i64 * 180;
            ev.push(agent(s));
            ev.push(prompt(s + 60, text));
        }
        let n = notes(ev);
        assert_eq!(n[1], "<span class=\"red\">dark flow</span>: short prompt in a run of 3, typing only");
    }
}
