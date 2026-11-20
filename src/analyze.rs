//! Turns a session's events into "your time" vs "agent time".
//!
//! The rule: time only counts when it's backed by something the human did. The gap
//! between the agent finishing and the human's next action is reviewing/testing time,
//! capped so walking away doesn't count. Agent runtime itself doesn't count.

use crate::model::{Event, EventKind, Session};
use chrono::{DateTime, Duration, Utc};

/// Agent events further apart than this are treated as the agent being idle.
const AGENT_TIMEOUT: i64 = 600;
/// If you reply within this long after the agent finishes, you were watching it work,
/// and up to this much of its runtime counts as reading along.
pub const WATCH_WINDOW: i64 = 120;
/// Longest gap counted as reviewing before a normal prompt.
pub const REVIEW_CAP: i64 = 600;
/// Longer cap when the prompt shows you tested something (screenshot, reported result,
/// or you ran a command first).
pub const TESTED_CAP: i64 = 1200;
/// Short cap before low-info prompts like "continue".
pub const LOW_INFO_CAP: i64 = 120;
/// After a gap longer than the cap (a break), we can't tell when you came back, so only
/// a short re-read plus typing counts.
const BREAK_BACK: i64 = 120;
/// Same, when the prompt shows you tested something after coming back.
const BREAK_BACK_TESTED: i64 = 300;
/// Low-info or repeated prompts closer together than this can form a dark-flow loop.
pub const LOOP_GAP: i64 = 900;
/// How many in a row before it's flagged.
const LOOP_MIN: usize = 3;
/// Most a prompt counts when there's nothing before it to measure from: the first one in
/// a session, or one right after a prompt the agent never answered.
pub const FIRST_PROMPT_MAX: i64 = 120;
/// Most a prompt in a dark-flow loop keeps.
pub const DARK_FLOW_KEEP: i64 = 30;

pub const TOOL_GROUPS: [&str; 7] = ["edit", "command", "read", "browser action", "web search", "subagent", "other call"];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TurnKind {
    Prompt,
    Interrupt,
    Shell,
    Command,
    Rejected,
}

/// Which rule set a turn's time, with the numbers it used. Only the report reads this,
/// to explain each row. It doesn't change any counting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// First action of the session, so there's nothing before it to measure from.
    First,
    /// Prompt after a gap longer than its cap: a catch-up time plus typing.
    Break { gap: i64, cap: i64, back: i64 },
    /// Prompt within the cap: the gap, plus `watch` of agent time if you replied fast.
    Reply { gap: i64, watch: i64, cap: i64 },
    /// Prompt where typing it takes longer than the wait.
    Typing { gap: i64, watch: i64 },
    /// Prompt cut down to the time since your last action.
    Wall { wall: i64 },
    /// Prompt right after a prompt the agent never answered: only typing counts, like a
    /// first prompt.
    NoReply { wall: i64 },
    /// Any other action: `secs` kept between `min` and `max`.
    Clamped { secs: i64, min: i64, max: i64 },
}

/// One human action, plus the agent activity that followed it.
pub struct Turn {
    pub t: DateTime<Utc>,
    pub kind: TurnKind,
    pub words: usize,
    pub tags: Vec<&'static str>,
    /// Time credited to the human for this action.
    pub human_secs: i64,
    /// Time that would have counted but didn't, because it was part of a dark-flow loop.
    pub flagged_secs: i64,
    /// Agent runtime after this action, until the next human action.
    pub agent_secs: i64,
    pub tools: [usize; 7],
    pub commits: usize,
    pub dark_flow: bool,
    pub why: Why,
    /// True if the gap in `why` runs from the agent's last step, false if from your
    /// last action (the agent did nothing in between, or this is a stop).
    pub from_agent: bool,
    /// Typing time of the prompt (0 for other actions).
    pub typed: i64,
    /// For dark flow: how many prompts were in the run.
    pub run: usize,
    /// Time that another session running at the same moment already counted, so it
    /// isn't counted again here. Set by `count_overlap_once`.
    pub overlap_secs: i64,
}

pub struct SessionReport {
    pub title: Option<String>,
    pub start: DateTime<Utc>,
    pub turns: Vec<Turn>,
}

impl SessionReport {
    pub fn human_secs(&self) -> i64 {
        self.turns.iter().map(|t| t.human_secs).sum()
    }
    pub fn agent_secs(&self) -> i64 {
        self.turns.iter().map(|t| t.agent_secs).sum()
    }
    pub fn flagged_secs(&self) -> i64 {
        self.turns.iter().map(|t| t.flagged_secs).sum()
    }
    pub fn overlap_secs(&self) -> i64 {
        self.turns.iter().map(|t| t.overlap_secs).sum()
    }
}

struct Segment {
    agent_secs: i64,
    last_agent: Option<DateTime<Utc>>,
    tools: [usize; 7],
}

fn segment(events: &[Event], start: DateTime<Utc>) -> Segment {
    let mut seg = Segment { agent_secs: 0, last_agent: None, tools: [0; 7] };
    let mut prev = start;
    for e in events {
        if let EventKind::Agent { tools } = &e.kind {
            let d = (e.t - prev).num_seconds();
            if (0..=AGENT_TIMEOUT).contains(&d) {
                seg.agent_secs += d;
            }
            prev = e.t;
            seg.last_agent = Some(e.t);
            for name in tools {
                seg.tools[tool_group(name)] += 1;
            }
        }
    }
    seg
}

fn tool_group(name: &str) -> usize {
    match name {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => 0,
        "Bash" | "BashOutput" | "KillShell" | "PowerShell" => 1,
        "Read" | "Grep" | "Glob" | "LS" => 2,
        "WebSearch" | "WebFetch" => 4,
        "Task" | "Agent" | "SendMessage" => 5,
        n if n.contains("rowser") || n.contains("chrome") || n.contains("computer") => 3,
        _ => 6,
    }
}

pub fn analyze(session: &Session, commits: &[DateTime<Utc>]) -> SessionReport {
    let ev = &session.events;
    let start = ev.first().map(|e| e.t).unwrap_or_else(Utc::now);
    let end = ev.last().map(|e| e.t).unwrap_or(start);
    let humans: Vec<usize> = (0..ev.len()).filter(|&i| ev[i].is_human()).collect();
    let segments: Vec<Segment> = humans
        .iter()
        .enumerate()
        .map(|(k, &i)| {
            let stop = humans.get(k + 1).copied().unwrap_or(ev.len());
            segment(&ev[i + 1..stop], ev[i].t)
        })
        .collect();

    let mut turns = Vec::with_capacity(humans.len());
    let mut loopy = Vec::with_capacity(humans.len());
    let mut typing = Vec::with_capacity(humans.len());
    let mut last_prompt = None;
    let mut ran_command = false;

    for (k, &i) in humans.iter().enumerate() {
        let e = &ev[i];
        // (gap since the agent last did something, agent runtime before this, time since
        // last human action, whether the agent did anything since then)
        let prev = (k > 0).then(|| {
            let prev_t = ev[humans[k - 1]].t;
            let seg = &segments[k - 1];
            let anchor = seg.last_agent.unwrap_or(prev_t);
            (
                (e.t - anchor).num_seconds().max(0),
                seg.agent_secs,
                (e.t - prev_t).num_seconds().max(0),
                seg.last_agent.is_some(),
            )
        });

        let mut tags = Vec::new();
        let mut is_loopy = false;
        let mut typed = 0;
        let mut from_agent = prev.is_some_and(|p| p.3);
        let after_prompt = k > 0 && matches!(ev[humans[k - 1]].kind, EventKind::Prompt(_));

        let (kind, words, human_secs, why) = match &e.kind {
            EventKind::Prompt(p) => {
                let tested = p.observation || ran_command;
                let repeat = last_prompt.is_some_and(|lp| p.words >= 3 && p.similarity(lp) >= 0.6);
                if p.images > 0 {
                    tags.push("screenshot");
                } else if p.observation {
                    tags.push("reported a result");
                }
                if ran_command {
                    tags.push("ran a command first");
                }
                if p.specific >= 2 {
                    tags.push("specific");
                }
                if p.generic {
                    tags.push("low info");
                }
                if repeat {
                    tags.push("repeat");
                }

                typed = p.typing_secs();
                // Every prompt is capped at the time since your last action, so pasting
                // long prompts back to back can't count more than the time that passed.
                let (secs, why) = match prev {
                    None => (typed.min(FIRST_PROMPT_MAX), Why::First),
                    // The agent never answered the last prompt, so there was nothing to
                    // review or test: only typing counts.
                    Some((_, _, wall, false)) if after_prompt => (typed.min(FIRST_PROMPT_MAX).min(wall), Why::NoReply { wall }),
                    Some((gap, agent_prev, wall, _)) => {
                        let cap = if p.generic {
                            LOW_INFO_CAP
                        } else if tested {
                            TESTED_CAP
                        } else {
                            REVIEW_CAP
                        };
                        if gap > cap {
                            let back = if tested { BREAK_BACK_TESTED } else { BREAK_BACK };
                            ((typed + back).min(cap.max(typed)).min(wall), Why::Break { gap, cap, back })
                        } else {
                            let watch = if gap <= WATCH_WINDOW { agent_prev.min(WATCH_WINDOW) } else { 0 };
                            let reply = gap + watch;
                            let want = reply.max(typed);
                            let secs = want.min(wall);
                            let why = if secs < want {
                                Why::Wall { wall }
                            } else if typed > reply {
                                Why::Typing { gap, watch }
                            } else {
                                Why::Reply { gap, watch, cap }
                            };
                            (secs, why)
                        }
                    }
                };
                is_loopy = (p.generic || repeat) && !tested;
                last_prompt = Some(p);
                ran_command = false;
                (TurnKind::Prompt, p.words, secs, why)
            }
            EventKind::Interrupt => {
                // Measured from your last action, whatever the agent did since.
                from_agent = false;
                let (secs, why) = clamped(prev.map(|p| p.2), 10, 5, 300);
                (TurnKind::Interrupt, 0, secs, why)
            }
            EventKind::Shell => {
                ran_command = true;
                let (secs, why) = clamped(prev.map(|p| p.0), 10, 10, 300);
                (TurnKind::Shell, 0, secs, why)
            }
            EventKind::Command => {
                let (secs, why) = clamped(prev.map(|p| p.0), 5, 5, 30);
                (TurnKind::Command, 0, secs, why)
            }
            EventKind::Rejected => {
                let (secs, why) = clamped(prev.map(|p| p.0), 10, 10, 60);
                (TurnKind::Rejected, 0, secs, why)
            }
            EventKind::Agent { .. } => unreachable!("only human events become turns"),
        };

        let next_t = humans.get(k + 1).map(|&j| ev[j].t).unwrap_or(end + Duration::minutes(10));
        let commits_in = commits.partition_point(|c| *c < next_t) - commits.partition_point(|c| *c < e.t);

        turns.push(Turn {
            t: e.t,
            kind,
            words,
            tags,
            human_secs,
            flagged_secs: 0,
            agent_secs: segments[k].agent_secs,
            tools: segments[k].tools,
            commits: commits_in,
            dark_flow: false,
            why,
            from_agent,
            typed,
            run: 0,
            overlap_secs: 0,
        });
        loopy.push(is_loopy);
        typing.push(typed);
    }

    mark_dark_flow(&mut turns, &loopy, &typing);
    SessionReport { title: session.title.clone(), start, turns }
}

/// Time for actions other than prompts: `since` kept between `min` and `max`, or a flat
/// `first` if it's the first thing in the session.
fn clamped(since: Option<i64>, first: i64, min: i64, max: i64) -> (i64, Why) {
    match since {
        None => (first.max(min), Why::First),
        Some(s) => (s.min(max).max(min), Why::Clamped { secs: s, min, max }),
    }
}

/// 3+ low-info or near-repeat prompts in a row, close together, with no testing in
/// between: only typing time counts for those.
fn mark_dark_flow(turns: &mut [Turn], loopy: &[bool], typing: &[i64]) {
    let prompts: Vec<usize> = (0..turns.len()).filter(|&i| turns[i].kind == TurnKind::Prompt).collect();
    let mut a = 0;
    while a < prompts.len() {
        if !loopy[prompts[a]] {
            a += 1;
            continue;
        }
        let mut b = a;
        while b + 1 < prompts.len()
            && loopy[prompts[b + 1]]
            && (turns[prompts[b + 1]].t - turns[prompts[b]].t).num_seconds() <= LOOP_GAP
        {
            b += 1;
        }
        if b - a + 1 >= LOOP_MIN {
            for &i in &prompts[a..=b] {
                let t = &mut turns[i];
                let keep = typing[i].min(DARK_FLOW_KEEP).min(t.human_secs);
                t.flagged_secs = t.human_secs - keep;
                t.human_secs = keep;
                t.dark_flow = true;
                t.run = b - a + 1;
            }
        }
        a = b + 1;
    }
}

/// Several sessions at once (two windows, two tools, two computers) would each count the
/// same minutes. A turn's time covers the stretch right before it, so going through every
/// turn of every session in time order, only the part of that stretch that no earlier
/// turn already covered counts. The rest moves to `overlap_secs`. Works in milliseconds,
/// like web/steer.js, so both give the same totals.
pub fn count_overlap_once<'a>(turns: impl IntoIterator<Item = &'a mut Turn>) {
    let mut all: Vec<&mut Turn> = turns.into_iter().filter(|t| t.human_secs > 0).collect();
    all.sort_by_key(|t| t.t);
    // Covered stretches, merged and in order. Every one ends at or before the turn being
    // looked at, since turns go in time order.
    let mut covered: Vec<(i64, i64)> = Vec::new();
    for turn in all {
        let end = turn.t.timestamp_millis();
        let start = end - turn.human_secs * 1000;
        let mut already = 0;
        for &(a, b) in covered.iter().rev() {
            if b <= start {
                break;
            }
            already += b - a.max(start);
        }
        let fresh = (end - start - already) / 1000;
        turn.overlap_secs = turn.human_secs - fresh;
        turn.human_secs = fresh;
        let mut merged_start = start;
        while covered.last().is_some_and(|&(_, b)| b >= start) {
            merged_start = merged_start.min(covered.pop().unwrap().0);
        }
        covered.push((merged_start, end));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::PromptInfo;

    fn at(min: i64, sec: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + min * 60 + sec, 0).unwrap()
    }
    fn prompt(t: DateTime<Utc>, text: &str) -> Event {
        Event { id: None, t, kind: EventKind::Prompt(PromptInfo::analyze(text, 0)) }
    }
    fn agent(t: DateTime<Utc>) -> Event {
        Event { id: None, t, kind: EventKind::Agent { tools: vec!["Edit".into()] } }
    }
    fn run(events: Vec<Event>) -> SessionReport {
        analyze(&Session { cwd: None, title: None, events }, &[])
    }

    fn long(t: DateTime<Utc>) -> Event {
        // 1300 characters: typing it would take the full 5 min
        prompt(t, &"make the enemy in wave.rs dodge left when the player shoots at it ".repeat(20))
    }

    #[test]
    fn pasting_fast_counts_no_more_than_the_real_time() {
        let mut ev = vec![long(at(0, 0)), agent(at(0, 1))];
        for s in (2..=30).step_by(2) {
            ev.push(long(at(0, s)));
            ev.push(agent(at(0, s + 1)));
        }
        let r = run(ev);
        assert!(r.human_secs() <= 31 + FIRST_PROMPT_MAX, "got {}", r.human_secs());
    }

    #[test]
    fn unanswered_prompts_only_count_typing() {
        let ev: Vec<Event> = (0..10).map(|k| long(at(k * 10, 0))).collect();
        let r = run(ev);
        assert!(r.turns.iter().all(|t| t.human_secs <= FIRST_PROMPT_MAX));
        assert!(matches!(r.turns[1].why, Why::NoReply { .. }));
    }

    #[test]
    fn parallel_sessions_count_once() {
        let one = || {
            let mut ev = Vec::new();
            for k in 0..6 {
                ev.push(prompt(at(k * 14, 0), "add a pause menu to the game with resume and quit buttons"));
                for a in 1..=5 {
                    ev.push(agent(at(k * 14 + a, 0)));
                }
            }
            run(ev)
        };
        let alone = one().human_secs();
        let mut four = [one(), one(), one(), one()];
        count_overlap_once(four.iter_mut().flat_map(|s| s.turns.iter_mut()));
        assert_eq!(four.iter().map(SessionReport::human_secs).sum::<i64>(), alone);
        assert_eq!(four.iter().map(SessionReport::overlap_secs).sum::<i64>(), 3 * alone);
    }

    #[test]
    fn agent_runtime_does_not_count_as_yours() {
        // Prompt, agent works 30 min, you come back 5 min later with a real prompt.
        let mut ev = vec![prompt(at(0, 0), "add a pause menu to the game with resume and quit buttons")];
        for m in 1..=30 {
            ev.push(agent(at(m, 0)));
        }
        ev.push(prompt(at(35, 0), "the quit button in menu.rs closes the window instead of going to the title screen"));
        let r = run(ev);
        assert_eq!(r.agent_secs(), 30 * 60);
        // 5 min reviewing/testing plus typing the first prompt; not the 30 agent minutes.
        assert!(r.human_secs() < 7 * 60, "got {}", r.human_secs());
        assert!(r.human_secs() >= 5 * 60);
    }

    #[test]
    fn walking_away_is_capped() {
        let r = run(vec![
            prompt(at(0, 0), "make the enemies spawn in waves"),
            agent(at(2, 0)),
            prompt(at(180, 0), "now add a boss on wave 5 with more health"),
        ]);
        assert!(matches!(r.turns[1].why, Why::Break { .. }));
        // Not the 3 hours, and not the full 10-minute cap either: a re-read plus typing.
        assert!(r.human_secs() <= BREAK_BACK + 60, "got {}", r.human_secs());
    }

    #[test]
    fn slot_machine_loop_is_flagged() {
        let mut ev = vec![prompt(at(0, 0), "build a snake game in the browser")];
        for (i, text) in ["fix it", "continue", "fix it", "try again"].iter().enumerate() {
            let m = 2 + i as i64 * 3;
            ev.push(agent(at(m, 0)));
            ev.push(prompt(at(m + 1, 0), text));
        }
        let r = run(ev);
        let flagged = r.turns.iter().filter(|t| t.dark_flow).count();
        assert_eq!(flagged, 4);
        assert!(r.flagged_secs() > 0);
    }

    #[test]
    fn testing_breaks_the_loop() {
        let mut ev = vec![prompt(at(0, 0), "build a snake game in the browser")];
        ev.push(agent(at(2, 0)));
        ev.push(prompt(at(3, 0), "fix it"));
        ev.push(agent(at(5, 0)));
        ev.push(prompt(at(8, 0), "when i press the arrow keys the snake doesn't move"));
        ev.push(agent(at(10, 0)));
        ev.push(prompt(at(11, 0), "continue"));
        let r = run(ev);
        assert!(r.turns.iter().all(|t| !t.dark_flow));
    }
}
