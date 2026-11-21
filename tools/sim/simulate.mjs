// Simulates people coding with AI agents, so counting rules can be compared against a
// known true time instead of guessed. Each simulated day has a person of one kind doing
// real things (writing prompts, reading what the agent did, testing, coding by hand,
// looking things up, getting distracted, taking breaks) while an agent runs. steer only
// sees what it would see for real: prompts, tool calls, stops, and evidence (commands
// run in a terminal, saves, commits) when an activity would leave some. Every rule then
// counts the same days, and the error is counted time minus true time.
//   node tools/sim/simulate.mjs            score the rules
//   node tools/sim/simulate.mjs --check    compare simulated sessions with your real logs
//
// Where the numbers come from (research_notes/Best AI coding time tracking/):
// - agent turns: median about 45 s in Claude Code, 99.9th percentile about 45 min
//   (Anthropic, "Measuring AI agent autonomy", 2026), so lognormal(45 s, 1.3)
// - turns per session: typically 3 to 4 (Copilot agent telemetry 2026; Anthropic 2026)
// - how time splits with AI: coding about 24%, reading and searching 17%, testing and
//   debugging 14%, reviewing AI output 9%, prompting 8%, idle 10% (METR 2025)
// - watching the agent run: 11% to 38% of session time (Qiao et al. 2026)
// - gaps between turns: median about 3 to 4 min, 95th percentile 75 to 90 min (Copilot)
// Anything without a source (how often testing happens in a terminal, how long breaks
// are) is swept over a range in the "what if" runs.

import { execSync } from "node:child_process";
import { createReadStream, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RULE, SessionReader, buildReport, checks, fmtDur } from "../../web/steer.js";

// rule v1: the first curve, 8 min fade and no break rule.
const RULE_V1 = { ...RULE, fade: 480, breakAfter: Infinity };

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The rule from before rule v1 (fixed 10/20/2 min caps and a break rule), from git.
const OLD_COMMIT = "287b11d";
const oldFile = join(mkdtempSync(join(tmpdir(), "steer-sim-")), "old.mjs");
writeFileSync(oldFile, execSync(`git -C "${repo}" show ${OLD_COMMIT}:web/steer.js`));
const OLD = await import(oldFile);

// ---------- random numbers, the same every run ----------

let seed = 12345;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const logn = (median, sigma) => median * Math.exp(sigma * normal());
const chance = (p) => rand() < p;

// ---------- kinds of people ----------

// Per turn: chance of watching the agent run, how long it takes to come back after it
// stops when not watching (median seconds), and the chance of each thing done in the gap
// before the next prompt. `generic` is the share of prompts like "continue".
const PEOPLE = {
  focused: { watch: 0.6, lag: 30, test: 0.6, code: 0.3, research: 0.25, off: 0.1, brk: 0.04, generic: 0.08, commit: 0.15 },
  multitasker: { watch: 0.15, lag: 180, test: 0.4, code: 0.15, research: 0.2, off: 0.45, brk: 0.06, generic: 0.15, commit: 0.08 },
  vibecoder: { watch: 0.35, lag: 60, test: 0.25, code: 0.05, research: 0.05, off: 0.25, brk: 0.05, generic: 0.45, commit: 0.05 },
  careful: { watch: 0.7, lag: 20, test: 0.85, code: 0.5, research: 0.35, off: 0.08, brk: 0.04, generic: 0.03, commit: 0.25 },
};

// Two worlds, each tuned so what steer sees matches something real (checked with
// --check): "typical" matches Copilot agent telemetry, "like duck" matches duck's own
// Claude Code logs (long agent runs, long sessions, lots of long breaks). Plus things
// nobody has measured, swept in the "what if" runs: how much testing happens in a
// terminal, how long breaks and distractions are.
const WORLDS = {
  typical: { agentMedian: 45, agentSigma: 1.3, turnsMean: 4.5, genericBoost: 0, offBoost: 0, term: 0.5, breakMedian: 40 * 60, breakScale: 3, offMedian: 240, quick: 0.2, resume: 0.02, resumeMedian: 3 * 3600 },
  "like duck": { agentMedian: 120, agentSigma: 2.2, turnsMean: 13, genericBoost: 0.18, offBoost: 0.15, term: 0.5, breakMedian: 90 * 60, breakScale: 4.5, offMedian: 900, quick: 0.45, resume: 0.12, resumeMedian: 14 * 3600 },
};
const BASE = WORLDS.typical;

// ---------- one simulated day ----------

const T0 = Date.UTC(2026, 9, 1, 15);
let ids = 0;
const id = () => `e${ids++}`;

/**
 * Returns the sessions steer would see, the evidence it would get, and the true time:
 * minutes spent prompting, reading output, testing, coding, looking things up and
 * re-reading after a break. Watching the agent run is tracked apart, since agent time
 * isn't meant to count.
 */
function simulateDay(person, w, dayIndex) {
  let t = T0 + dayIndex * 86400 * 1000;
  const sessions = [];
  const evidence = [];
  let truth = 0;
  let watched = 0;
  const work = (secs) => {
    t += secs * 1000;
    truth += secs;
  };
  const idle = (secs) => {
    t += secs * 1000;
  };

  const sessionCount = 2 + Math.floor(rand() * 3);
  for (let s = 0; s < sessionCount; s++) {
    const events = [];
    const turns = 1 + Math.floor(-Math.log(1 - rand()) * (w.turnsMean - 1));
    let tested = false;
    for (let k = 0; k < turns; k++) {
      const generic = chance(Math.min(0.9, person.generic + w.genericBoost));
      const chars = generic ? 8 : Math.max(20, Math.round(logn(160, 0.9)));
      work(Math.max(5, Math.min(300, chars / 4)));
      events.push({
        id: id(),
        t,
        kind: "prompt",
        prompt: {
          chars,
          words: Math.max(1, Math.round(chars / 5)),
          images: 0,
          specific: generic ? 0 : 2,
          observation: tested && chance(0.6),
          generic,
          repeat: false,
        },
      });
      tested = false;

      // The agent works, calling tools every few seconds, then stops.
      const run = Math.min(logn(w.agentMedian, w.agentSigma), 8 * 3600);
      for (let a = logn(8, 0.6); a < run; a += logn(8, 0.6)) events.push({ id: id(), t: t + a * 1000, kind: "agent", tools: ["Edit"] });
      t += run * 1000;
      events.push({ id: id(), t, kind: "agent", tools: [] });
      if (chance(person.watch)) watched += run;
      else idle(logn(person.lag, 1));

      // Sometimes a quick reply right away (answering the agent's question, "yes", a
      // small follow-up), with nothing else in the gap.
      if (chance(w.quick)) {
        work(logn(15, 0.6));
        continue;
      }
      // The gap before the next prompt: read what it did, then some of the rest.
      work(logn(15 + Math.min(240, run * 0.15), 0.7));
      const things = [];
      if (chance(person.test)) things.push("test");
      if (chance(person.code)) things.push("code");
      if (chance(person.research)) things.push("research");
      if (chance(person.off + w.offBoost)) things.push("off");
      if (chance(person.brk * w.breakScale)) things.push("break");
      things.sort(() => rand() - 0.5);
      for (const what of things) {
        if (what === "test") {
          const dur = logn(150, 0.8);
          const inTerminal = chance(w.term);
          const runs = Math.max(1, Math.round(dur / 90));
          for (let r = 1; r <= runs; r++) {
            work(dur / runs);
            if (inTerminal) evidence.push({ id: id(), t, kind: "run", name: "npm", exit: chance(0.4) ? 1 : 0 });
          }
          tested = true;
        } else if (what === "code") {
          const dur = logn(180, 0.8);
          const end = t + dur * 1000;
          for (let at = t + logn(60, 0.5) * 1000; at < end; at += logn(60, 0.5) * 1000) evidence.push({ id: id(), t: at, kind: "save", count: 1 });
          work(dur);
          evidence.push({ id: id(), t, kind: "save", count: 1 });
        } else if (what === "research") {
          work(logn(180, 0.9));
        } else if (what === "off") {
          idle(logn(w.offMedian, 1));
        } else {
          idle(logn(w.breakMedian, 1.1));
          work(60); // re-read where you were
        }
      }
      // Coming back to the same chat hours later, or the next day.
      if (chance(w.resume)) {
        idle(logn(w.resumeMedian, 0.7));
        work(60);
      }
      if (chance(person.commit)) {
        work(20);
        evidence.push({ id: id(), t, kind: "commit" });
      }
    }
    sessions.push({ path: `d${dayIndex}s${s}`, cwd: "/home/x/game", title: null, events });
    idle(logn(2.5 * 3600, 0.6)); // until the next session
  }
  return { sessions, evidence, truth, watched };
}

// ---------- the rules being compared ----------

const now = Date.UTC(2030, 0, 1);
const total = (projects) => projects.reduce((n, p) => n + p.sessions.reduce((m, s) => m + s.turns.reduce((k, u) => k + u.human, 0), 0), 0);
const evidenceSession = (evidence) => ({ path: "evidence:game", cwd: "/home/x/game", title: null, evidence: true, events: evidence });
const steer = (rule, withEvidence) => (day) =>
  total(buildReport(withEvidence ? [...day.sessions, evidenceSession(day.evidence)] : day.sessions, { days: null, now, rule }));

/** Heartbeat style: every human moment on one timeline, each gap counted up to `cap`
 * (dropped entirely past it when `drop` is set, like WakaTime). */
const heartbeats = (cap, drop, withAgent) => (day) => {
  const times = [];
  for (const s of day.sessions) for (const e of s.events) if (withAgent || e.kind !== "agent") times.push(e.t);
  for (const e of day.evidence) times.push(e.t);
  times.sort((a, b) => a - b);
  let secs = 0;
  for (let i = 1; i < times.length; i++) {
    const g = (times[i] - times[i - 1]) / 1000;
    secs += g <= cap ? g : drop ? 0 : cap;
  }
  return secs;
};

const RULES = {
  "old caps (10/20/2 min)": (day) => total(OLD.buildReport(day.sessions, { days: null, now })),
  "rule v1 (curve)": steer(RULE_V1, false),
  "rule v1 + evidence": steer(RULE_V1, true),
  "curve, break after 30 min": steer({ ...RULE_V1, breakAfter: 1800 }, false),
  "curve, break after 30 min + evidence": steer({ ...RULE_V1, breakAfter: 1800 }, true),
  "curve, break after 20 min + evidence": steer({ ...RULE_V1, breakAfter: 1200 }, true),
  "short fade, break after 30 min + evidence": steer({ ...RULE_V1, fade: 240, breakAfter: 1800 }, true),
  "short fade, break after 20 min + evidence": steer({ ...RULE_V1, fade: 240, breakAfter: 1200 }, true),
  "short fade, break after 45 min + evidence": steer({ ...RULE_V1, fade: 240, breakAfter: 2700 }, true),
  "2 min fade, break after 30 min + evidence": steer({ ...RULE_V1, fade: 120, breakAfter: 1800 }, true),
  "short fade, 2 min after you, break 30 + ev.": steer({ ...RULE_V1, fade: 240, fullYou: 120, breakAfter: 1800 }, true),
  "hackatime style (2 min per gap)": heartbeats(120, false, false),
  "wakatime style (15 min or nothing)": heartbeats(900, true, false),
  "reviewers' 1/3 of ai time": (day) => heartbeats(900, true, true)(day) / 3,
};

// ---------- scoring ----------

const DAYS = 150;

/** For each rule and kind of person: counted / true, and the typical miss per day. */
function score(w) {
  const out = {};
  for (const [who, person] of Object.entries(PEOPLE)) {
    seed = 1000 + Object.keys(PEOPLE).indexOf(who);
    const days = Array.from({ length: DAYS }, (_, i) => simulateDay(person, w, i));
    const truth = days.reduce((n, d) => n + d.truth, 0);
    for (const [name, rule] of Object.entries(RULES)) {
      const counted = days.map(rule);
      const sum = counted.reduce((a, b) => a + b, 0);
      const miss = days.reduce((n, d, i) => n + Math.abs(counted[i] - d.truth), 0) / DAYS;
      out[name] ??= {};
      out[name][who] = { ratio: sum / truth, missPerDay: miss, truthPerDay: truth / DAYS };
    }
  }
  return out;
}

function showScores(title, scores) {
  console.log(`\n${title}`);
  const people = Object.keys(PEOPLE);
  console.log(`  ${"rule".padEnd(42)}${people.map((p) => p.padEnd(13)).join("")}worst`);
  for (const [name, byWho] of Object.entries(scores)) {
    const cells = people.map((p) => `${Math.round(byWho[p].ratio * 100)}%`.padEnd(13));
    const worst = Math.max(...people.map((p) => Math.abs(byWho[p].ratio - 1)));
    console.log(`  ${name.padEnd(42)}${cells.join("")}${Math.round(worst * 100)}% off`);
  }
}

// ---------- cheaters ----------

/** Days a script or an AI fakes. The true time is zero. */
function cheaterDays(kind) {
  seed = 777;
  const days = [];
  for (let d = 0; d < 20; d++) {
    let t = T0 + d * 86400 * 1000;
    const end = t + 12 * 3600 * 1000;
    const events = [];
    const evidence = [];
    while (t < end) {
      const chars = Math.round(logn(200, 0.4));
      events.push({ id: id(), t, kind: "prompt", prompt: { chars, words: Math.round(chars / 5), images: 0, specific: 2, observation: false, generic: false, repeat: false } });
      const run = kind === "script" ? 30 + rand() * 60 : Math.min(logn(45, 1.3), 1800);
      for (let a = 8; a < run; a += 8) events.push({ id: id(), t: t + a * 1000, kind: "agent", tools: ["Edit"] });
      t += run * 1000;
      events.push({ id: id(), t, kind: "agent", tools: [] });
      if (kind === "script") t += logn(6 * 60, 0.3) * 1000;
      else if (kind === "human-like script") {
        // copies a real rhythm: uneven gaps, a long break now and then, stops for the night
        t += (chance(0.05) ? logn(40 * 60, 0.6) : logn(3 * 60, 1)) * 1000;
      }
      else if (kind === "auto-prompter") t += (3 + rand() * 12) * 1000;
      else {
        // fake saves every 2 minutes for 20 minutes, then a prompt
        for (let m = 1; m <= 9; m++) evidence.push({ id: id(), t: t + m * 120 * 1000, kind: "save", count: 1 });
        t += 20 * 60 * 1000;
      }
    }
    days.push({ sessions: [{ path: `c${d}`, cwd: "/home/x/game", title: null, events }], evidence, truth: 0 });
  }
  return days;
}

/** Share of days the reviewer checks point at something, with the given rule. */
const flaggedShare = (days, rule) =>
  days.filter((d) => checks(buildReport([...d.sessions, evidenceSession(d.evidence)], { days: null, now, rule })).length > 0).length / days.length;

// ---------- your real logs, to check the simulation looks real ----------

async function realSessions() {
  const root = join(homedir(), ".claude", "projects");
  const out = [];
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    if (!statSync(d).isDirectory()) continue;
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".jsonl")) continue;
      const r = new SessionReader(`projects/${dir}/${name}`);
      for await (const line of createInterface({ input: createReadStream(join(d, name)), crlfDelay: Infinity })) r.line(line);
      const s = r.finish();
      if (s && s.events.length && s.events[s.events.length - 1].t > Date.now() - 30 * 86400 * 1000) out.push(s);
    }
  }
  return out;
}

/** What steer can see either way: gaps after the agent stops, agent turn lengths,
 * prompts per session, and how many prompts are like "continue". */
function observables(sessions) {
  const gaps = [];
  const turns = [];
  const perSession = [];
  let prompts = 0;
  let generic = 0;
  for (const s of sessions) {
    let n = 0;
    let lastHuman = null;
    let lastAgent = null;
    for (const e of s.events) {
      if (e.kind === "agent") {
        lastAgent = e.t;
        continue;
      }
      if (e.kind !== "prompt") continue;
      n++;
      prompts++;
      if (e.prompt.generic) generic++;
      if (lastHuman !== null && lastAgent !== null && lastAgent > lastHuman) {
        turns.push((lastAgent - lastHuman) / 1000);
        gaps.push((e.t - lastAgent) / 1000);
      }
      lastHuman = e.t;
    }
    if (n) perSession.push(n);
  }
  const q = (xs, p) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
  };
  const m = (secs) => (secs < 60 ? `${Math.round(secs)}s` : fmtDur(Math.round(secs)));
  return {
    "gap after the agent stops, 25/50/75/90/95%": [0.25, 0.5, 0.75, 0.9, 0.95].map((p) => m(q(gaps, p))).join(" / "),
    "agent turn, 50/90/99%": [0.5, 0.9, 0.99].map((p) => m(q(turns, p))).join(" / "),
    "prompts per session, median": q(perSession, 0.5),
    "prompts like 'continue'": `${Math.round((100 * generic) / Math.max(1, prompts))}%`,
  };
}

// ---------- run ----------

const simObservables = (w) => {
  seed = 42;
  const kinds = Object.values(PEOPLE);
  return observables(Array.from({ length: 200 }, (_, i) => simulateDay(kinds[i % kinds.length], w, i).sessions).flat());
};

if (process.argv.includes("--notes")) {
  // Which checks fire, for each cheater and kind of honest person.
  const PICK = { ...RULE_V1, fade: 240, breakAfter: 1800 };
  const tally = (days) => {
    const n = {};
    for (const d of days) for (const c of checks(buildReport([...d.sessions, evidenceSession(d.evidence)], { days: null, now, rule: PICK }))) for (const x of c.notes) n[x.replace(/[\d]+[hms]?( \d+m)?/g, "N")] = (n[x.replace(/[\d]+[hms]?( \d+m)?/g, "N")] ?? 0) + 1;
    return n;
  };
  for (const k of ["script", "auto-prompter", "fake saver"]) console.log(k, tally(cheaterDays(k)));
  for (const [wn, w] of Object.entries(WORLDS))
    for (const [who, person] of Object.entries(PEOPLE)) {
      seed = 5000 + Object.keys(PEOPLE).indexOf(who);
      console.log(wn, who, tally(Array.from({ length: 60 }, (_, i) => simulateDay(person, w, i))));
    }
} else if (process.argv.includes("--check")) {
  const real = observables(await realSessions());
  const duck = simObservables(WORLDS["like duck"]);
  const typical = simObservables(WORLDS.typical);
  for (const k of Object.keys(real)) console.log(`${k}\n  your logs:        ${real[k]}\n  sim "like duck":  ${duck[k]}\n  sim "typical":    ${typical[k]}`);
  console.log("\ncopilot agent telemetry (13.5M sessions), what \"typical\" should look like: gap between turns median about 3 to 4 min, 95% about 75 to 90 min, median 3 prompts per session");
} else {
  for (const [name, w] of Object.entries(WORLDS)) showScores(`world "${name}": counted time as a share of true time (100% is right)`, score(w));
  const sweeps = {};
  for (const [wn, w] of Object.entries(WORLDS)) {
    sweeps[`${wn}`] = w;
    sweeps[`${wn}, little testing in a terminal`] = { ...w, term: 0.2 };
    sweeps[`${wn}, lots of testing in a terminal`] = { ...w, term: 0.8 };
    sweeps[`${wn}, twice as many breaks`] = { ...w, breakScale: w.breakScale * 2 };
    sweeps[`${wn}, short breaks`] = { ...w, breakMedian: 15 * 60 };
    sweeps[`${wn}, long distractions`] = { ...w, offMedian: 600 };
  }
  const worst = {};
  for (const [name, w] of Object.entries(sweeps)) {
    const s = score(w);
    for (const [rule, byWho] of Object.entries(s)) {
      const off = Math.max(...Object.values(byWho).map((x) => Math.abs(x.ratio - 1)));
      worst[rule] = Math.max(worst[rule] ?? 0, off);
    }
  }
  console.log("\nworst case across all kinds of people and all the what-ifs (lower is better)");
  for (const [rule, off] of Object.entries(worst).sort((a, b) => a[1] - b[1])) console.log(`  ${rule.padEnd(42)}${Math.round(off * 100)}% off`);

  console.log("\nwhat a cheater gets per 12 hour day (the true time is zero, before the 12h daily cap)");
  const kinds = ["script", "human-like script", "auto-prompter", "fake saver"];
  console.log(`  ${"rule".padEnd(42)}${kinds.map((k) => k.padEnd(16)).join("")}`);
  const days = Object.fromEntries(kinds.map((k) => [k, cheaterDays(k)]));
  for (const [name, rule] of Object.entries(RULES)) {
    const cells = kinds.map((k) => fmtDur(Math.round(days[k].reduce((n, d) => n + rule(d), 0) / days[k].length)).padEnd(16));
    console.log(`  ${name.padEnd(42)}${cells.join("")}`);
  }

  const PICK = { ...RULE_V1, fade: 240, breakAfter: 1800 };
  console.log("\nhow often the reviewer checks point at a day (short fade, break after 30 min + evidence)");
  console.log(`  cheaters: ${kinds.map((k) => `${k} ${Math.round(100 * flaggedShare(days[k], PICK))}%`).join(", ")}`);
  for (const [wn, w] of Object.entries(WORLDS)) {
    const cells = Object.entries(PEOPLE).map(([who, person]) => {
      seed = 5000 + Object.keys(PEOPLE).indexOf(who);
      const honest = Array.from({ length: 60 }, (_, i) => simulateDay(person, w, i));
      return `${who} ${Math.round(100 * flaggedShare(honest, PICK))}%`;
    });
    console.log(`  honest people, world "${wn}": ${cells.join(", ")}`);
  }
}
