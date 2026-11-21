// Replays the ways people tried to get time they didn't earn (from the red team on
// 2026-11-20) against the counting code the server and the website use, and checks an
// honest session still counts normally:
//   node tests/counting.mjs

import assert from "node:assert/strict";
import { analyzePrompt, applyCaps, buildReport, checks, projectHuman, projectOverlap, rulesFrom } from "../web/steer.js";

const T0 = Date.UTC(2026, 10, 20, 15, 0, 0);
const sec = (s) => T0 + s * 1000;
let ids = 0;
const prompt = (s, chars, extra = {}) => ({
  id: `e${ids++}`,
  t: sec(s),
  kind: "prompt",
  prompt: { words: Math.round(chars / 5), chars, images: 0, specific: 2, observation: false, generic: false, repeat: false, ...extra },
});
const agent = (s, tools = ["Edit"]) => ({ id: `e${ids++}`, t: sec(s), kind: "agent", tools });
const session = (name, events, project = "game") => ({ path: `p/${name}.jsonl`, cwd: `/home/x/${project}`, title: null, events });
const total = (sessions) => buildReport(sessions, { days: null, now: sec(10 * 86400) }).reduce((n, p) => n + projectHuman(p), 0);

// 1. 1000 long prompts sent at the same moment used to count 5 min each (83 hours).
{
  const events = [];
  for (let i = 0; i < 1000; i++) events.push(prompt(0, 1300));
  assert.ok(total([session("burst", events)]) <= 120, "a burst of prompts can't count more than the time that passed");
}

// 2. The same burst spread over 1000 separate sessions.
{
  const sessions = [];
  for (let i = 0; i < 1000; i++) sessions.push(session(`fan${i}`, [prompt(0, 1300), agent(5)]));
  assert.ok(total(sessions) <= 120, "1000 sessions at once count the same minutes once");
}

// 3. Pasting a long prompt every second for 30 s used to count 5 min each.
{
  const events = [prompt(0, 1300), agent(1)];
  for (let s = 2; s <= 30; s += 2) events.push(prompt(s, 1300), agent(s + 1));
  assert.ok(total([session("paste", events)]) <= 31 + 120, "pasting fast counts no more than the real time");
}

// 4. Prompts only, no agent ever answering, one every 10 min for a day.
{
  const events = [];
  for (let s = 0; s < 86400; s += 600) events.push(prompt(s, 1300));
  assert.ok(total([session("lazy", events)]) <= 144 * 120, "unanswered prompts only count typing time");
}

// 5. The same honest work in 4 parallel sessions counts once.
const honest = () => {
  const events = [];
  for (let k = 0; k < 6; k++) {
    const s = k * 840;
    events.push(prompt(s, 300));
    for (let a = 10; a <= 300; a += 30) events.push(agent(s + a));
  }
  return events;
};
{
  const one = total([session("solo", honest())]);
  const four = buildReport(["a", "b", "c", "d"].map((n) => session(n, honest(), `proj-${n}`)), { days: null, now: sec(10 * 86400) });
  assert.equal(four.reduce((n, p) => n + projectHuman(p), 0), one, "parallel sessions count once");
  assert.ok(four.reduce((n, p) => n + projectOverlap(p), 0) >= 3 * one - 10, "the rest shows up as overlap");
}

// 6. Dark flow: a run of short "continue"s keeps at most 30s each.
{
  const events = [];
  for (let k = 0; k < 6; k++) {
    events.push(prompt(k * 60, 1300, { generic: true, specific: 0 }));
    events.push(agent(k * 60 + 30));
  }
  const p = buildReport([session("loop", events)], { days: null, now: sec(10 * 86400) })[0];
  for (const t of p.sessions[0].turns.slice(1)) assert.ok(t.human <= 30, `dark flow kept ${t.human}s`);
}

// 7. An honest session still counts what it should: 6 prompts 14 min apart, the agent
// works about 5 min after each and you read and test for the 560 s after that.
{
  const r = total([session("normal", honest())]);
  // first prompt: 75 s of typing, then 5 replies of 560 s each
  assert.equal(r, 75 + 5 * 560, `honest session counted ${r}s`);
}

// 8. Checks a reviewer sees. A script that runs for 2 days with a real looking rhythm
// (prompt, agent works 1 to 2 min, 2 to 9 min of "review") gets flagged.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const reportOf = (sessions) => buildReport(sessions, { days: null, now: sec(10 * 86400) });
{
  const events = [];
  for (let s = 0; s < 2 * 86400; ) {
    events.push(prompt(s, 200 + Math.round(rand() * 400)));
    const work = 60 + Math.round(rand() * 60);
    for (let a = 10; a < work; a += 20) events.push(agent(s + a));
    events.push(agent(s + work));
    s += work + 120 + Math.round(rand() * 420);
  }
  const notes = checks(reportOf([session("script", events)])).flatMap((d) => d.notes).join(" | ");
  assert.match(notes, /counted in one day/);
  assert.match(notes, /no break longer than/);
}
// An auto-prompter answering a few seconds after every stop.
{
  const events = [];
  for (let k = 0, s = 0; k < 40; k++) {
    events.push(prompt(s, 400));
    const work = 120 + Math.round(rand() * 180);
    for (let a = 15; a < work; a += 30) events.push(agent(s + a));
    events.push(agent(s + work));
    s += work + 3 + Math.round(rand() * 10);
  }
  const notes = checks(reportOf([session("bot", events)])).flatMap((d) => d.notes).join(" | ");
  assert.match(notes, /replies usually came \d+s after the agent stopped/);
}
// 9. Payable caps: a script running for a week keeps at most 12h a UTC day and 60h a UTC
// week, while the checks still point out what it tried to claim.
{
  const events = [];
  for (let s = 0; s < 7 * 86400; ) {
    events.push(prompt(s, 400));
    events.push(agent(s + 60));
    s += 60 + 400 + Math.round(rand() * 120);
  }
  const report = reportOf([session("week", events)]);
  const before = report.reduce((n, p) => n + projectHuman(p), 0);
  applyCaps(report, rulesFrom());
  const turns = report.flatMap((p) => p.sessions.flatMap((s) => s.turns));
  const perDay = new Map();
  for (const t of turns) perDay.set(new Date(t.t).toISOString().slice(0, 10), (perDay.get(new Date(t.t).toISOString().slice(0, 10)) ?? 0) + t.human);
  for (const [day, secs] of perDay) assert.ok(secs <= 12 * 3600, `${day} kept ${secs}s`);
  const monday = (t) => {
    const d = new Date(t);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const perWeek = new Map();
  for (const t of turns) perWeek.set(monday(t.t), (perWeek.get(monday(t.t)) ?? 0) + t.human);
  for (const [week, secs] of perWeek) assert.ok(secs <= 60 * 3600, `week of ${week} kept ${secs}s`);
  const after = report.reduce((n, p) => n + projectHuman(p), 0);
  assert.equal(after + turns.reduce((n, t) => n + t.capped, 0), before, "what's cut shows up as capped");
  assert.match(checks(report).flatMap((d) => d.notes).join(" | "), /counted in one day/);
  // A program running a hackathon can raise them.
  const loose = reportOf([session("week", events)]);
  applyCaps(loose, rulesFrom({ dailyCapHours: 24, weeklyCapHours: 168 }));
  assert.equal(loose.reduce((n, p) => n + projectHuman(p), 0), before);
}
// The honest session from 7 has nothing to look at.
assert.deepEqual(checks(reportOf([session("normal", honest())])), []);

// 10. A bare "ok" right after a long agent run is an approval: no watching time.
{
  const events = [prompt(0, 300)];
  for (let a = 60; a <= 1200; a += 60) events.push(agent(a));
  events.push(prompt(1220, 2, { generic: true, specific: 0 }));
  const okTurn = reportOf([session("ok", events)])[0].sessions[0].turns[1];
  assert.ok(okTurn.human <= 25, `a bare ok got ${okTurn.human}s`);
}

// 11. Pasted text (marked by Claude Code's hook) isn't typing.
{
  const trace = "Traceback src/main.py line 4 src/db.py line 9 ".repeat(30);
  const p = analyzePrompt(`why does this crash <pasted_content id="1">${trace}</pasted_content>`, 0);
  assert.equal(p.words, 4);
  assert.ok(p.specific <= p.words + 2);
  assert.equal(analyzePrompt("fix the jump", 0).words, 3);
}

console.log("counting tests passed");
