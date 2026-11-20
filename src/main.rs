mod analyze;
mod claude;
mod git;
mod live;
mod model;
mod prompt;
mod report;

use chrono::{DateTime, Utc};
use std::collections::BTreeMap;
use std::path::PathBuf;

struct Args {
    days: Option<i64>,
    out: PathBuf,
    root: Option<PathBuf>,
    hide_titles: bool,
}

const HELP: &str = "steer: shows how much time you spent working with your ai agent

report from your old claude code logs (runs on your computer, nothing gets uploaded):
  steer [report] [--days N | --all] [--out FILE] [--hide-titles] [--root DIR]

  --days N        only sessions active in the last N days (default 30)
  --all           every session
  --out FILE      where to write the HTML report (default steer-report.html)
  --hide-titles   don't show session titles in the report
  --root DIR      Claude Code projects folder (default ~/.claude/projects)
";

fn help() -> String {
    format!("{HELP}\n{}", live::HELP)
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut a = Args { days: Some(30), out: PathBuf::from("steer-report.html"), root: None, hide_titles: false };
    let mut it = args.iter().cloned();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--days" => {
                let v = it.next().ok_or("--days needs a number")?;
                a.days = Some(v.parse().map_err(|_| "--days needs a number")?);
            }
            "--all" => a.days = None,
            "--out" | "-o" => a.out = PathBuf::from(it.next().ok_or("--out needs a file path")?),
            "--root" => a.root = Some(PathBuf::from(it.next().ok_or("--root needs a folder")?)),
            "--hide-titles" => a.hide_titles = true,
            "-h" | "--help" => {
                println!("{}", help());
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(a)
}

fn main() {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("hook") => return live::hook(),
        Some("signup" | "login" | "setup" | "status" | "flush") => std::process::exit(live::command(&argv)),
        Some("report") => {
            argv.remove(0);
        }
        _ => {}
    }
    report(&argv);
}

fn report(argv: &[String]) {
    let args = parse_args(argv).unwrap_or_else(|e| {
        eprintln!("steer: {e}\n\n{}", help());
        std::process::exit(2);
    });
    let root = args.root.clone().or_else(claude::default_root).unwrap_or_else(|| {
        eprintln!("steer: couldn't find your home folder");
        std::process::exit(1);
    });
    let files = claude::find_session_files(&root);
    if files.is_empty() {
        eprintln!("steer: no Claude Code sessions found in {}", root.display());
        std::process::exit(1);
    }

    let cutoff = args.days.map(|d| Utc::now() - chrono::Duration::days(d));
    let mut commit_cache: BTreeMap<PathBuf, Vec<DateTime<Utc>>> = BTreeMap::new();
    let mut by_name: BTreeMap<String, report::Project> = BTreeMap::new();

    // Resumed or forked sessions copy old entries into a new file. Go through sessions
    // oldest first and keep each entry only the first time it shows up, so the same
    // time isn't counted twice.
    let mut sessions: Vec<model::Session> = files.iter().filter_map(|f| claude::parse_session(f)).collect();
    sessions.sort_by_key(|s| s.events.first().map(|e| e.t));
    let mut seen = std::collections::HashSet::new();

    for mut session in sessions {
        session.events.retain(|e| e.id.map_or(true, |id| seen.insert(id)));
        let Some(last) = session.events.last().map(|e| e.t) else { continue };
        if cutoff.is_some_and(|c| last < c) {
            continue;
        }
        let (name, repo) = git::project_for(session.cwd.as_deref());
        let commits = match &repo {
            Some(r) => commit_cache.entry(r.clone()).or_insert_with(|| git::my_commits(r)).as_slice(),
            None => &[],
        };
        let rep = analyze::analyze(&session, commits);
        if rep.turns.is_empty() {
            continue;
        }
        by_name.entry(name.clone()).or_insert_with(|| report::Project::new(name)).sessions.push(rep);
    }

    let mut projects: Vec<report::Project> = by_name.into_values().collect();
    for p in &mut projects {
        p.sessions.sort_by_key(|s| std::cmp::Reverse(s.start));
    }
    projects.sort_by_key(|p| std::cmp::Reverse(p.human_secs()));

    let window = match args.days {
        Some(1) => "last day".to_string(),
        Some(d) => format!("last {d} days"),
        None => "all time".to_string(),
    };
    let html = report::render(&projects, &report::Options { window: window.clone(), hide_titles: args.hide_titles });
    if let Err(e) = std::fs::write(&args.out, html) {
        eprintln!("steer: couldn't write {}: {e}", args.out.display());
        std::process::exit(1);
    }

    let human: i64 = projects.iter().map(report::Project::human_secs).sum();
    let agent: i64 = projects.iter().map(report::Project::agent_secs).sum();
    let flagged: i64 = projects.iter().map(report::Project::flagged_secs).sum();
    let sessions: usize = projects.iter().map(|p| p.sessions.len()).sum();
    println!("{sessions} sessions in {} projects, {window}", projects.len());
    println!("  your time            {}", report::fmt_dur(human));
    println!("  agent time           {}", report::fmt_dur(agent));
    println!("  1/3 rule             {}", report::fmt_dur(agent / 3));
    println!("  dark flow (ignored)  {}", report::fmt_dur(flagged));
    let shown = std::fs::canonicalize(&args.out).unwrap_or(args.out);
    println!("report: {}", shown.display());
}
