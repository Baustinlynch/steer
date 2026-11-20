//! Builds the HTML report. Prompt text never gets here.

use crate::analyze::{SessionReport, Turn, TurnKind, TOOL_GROUPS};
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

    let mut notes: Vec<String> = Vec::new();
    if t.break_before {
        notes.push("after break".into());
    }
    notes.extend(t.tags.iter().map(|s| s.to_string()));
    if t.commits > 0 {
        notes.push(plural(t.commits, "commit"));
    }
    let mut notes = notes.join(", ");
    if t.dark_flow {
        if !notes.is_empty() {
            notes.push_str(", ");
        }
        notes.push_str("<span class=\"red\">dark flow</span>");
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
        "<tr{row}><td>{when}</td><td>{action}</td><td>{notes}</td><td class=\"r\">{you}</td><td class=\"r\">{agent}</td><td>{did}</td></tr>\n",
        row = if t.dark_flow { " class=\"flow\"" } else { "" },
        did = did.join(", "),
    );
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
<li>Time between the agent finishing and your next prompt counts, up to 10 min. Up to 20 min if the prompt has a screenshot, describes what happened, or you ran a command first. Up to 2 min for prompts like "continue".</li>
<li>A longer gap is a break. Then only 2 min plus typing time counts (5 min if you tested something).</li>
<li>If you reply within 2 min of the agent finishing, up to 2 min of agent time counts too.</li>
<li>Agent time never counts as your time.</li>
<li>3 or more low info or repeated prompts in a row without testing is dark flow. Only typing time counts for those.</li>
<li>Prompts are only used for word counts and notes. The text isn't saved.</li>
<li>1/3 rule is agent time divided by 3, which is roughly what reviewers do now with Hackatime AI time.</li>
</ul>
"#;
