// Turns everyone's check-in answers (steer checkin on) into the numbers the credit
// curve needs: for each kind of moment and how long since the last thing happened,
// how often people said they were on their project, and how often steer counted it.
// Runs on the server's stored events and prints totals only, no names.
//   node tools/checkin-curve.mjs [data folder, default ./data]

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { buildReport } from "../web/steer.js";

const data = process.argv[2] ?? "data";
const dir = join(data, "events");
if (!existsSync(dir)) {
  console.log(`no events folder in ${data}`);
  process.exit(1);
}

const BINS = [1, 2, 5, 10, 20, 40, 60, Infinity]; // minutes, upper edges
const binOf = (mins) => BINS.findIndex((b) => mins < b);
const binName = (i) => (i === 0 ? "under 1m" : BINS[i] === Infinity ? `${BINS[i - 1]}m+` : `${BINS[i - 1]} to ${BINS[i]}m`);
const STATES = ["agent running", "after the agent stopped", "after your own action"];
const table = STATES.map(() => BINS.map(() => ({ n: 0, project: 0, withAi: 0, none: 0, counted: 0, projectCounted: 0 })));
const answers = { "project-ai": 0, project: 0, other: 0, none: 0 };
let people = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  // The same conversion the server does (sessionsOf in server.mjs).
  const bySession = new Map();
  const checkins = [];
  for await (const line of createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity })) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.late) continue;
    const t = Date.parse(e.t);
    if (e.kind === "checkin") {
      checkins.push({ t, answer: e.answer });
      continue;
    }
    const evidence = e.kind === "run" || e.kind === "save" || e.kind === "commit";
    const key = evidence ? `evidence:${e.project}` : e.session;
    if (!bySession.has(key)) bySession.set(key, { path: key, cwd: e.project, title: null, events: [], evidence });
    const s = bySession.get(key);
    if (evidence) {
      s.events.push({ id: e.id, t, kind: e.kind, name: e.name, exit: e.exit, count: e.count });
    } else if (e.kind === "prompt") {
      const { chars, words, images, specific, observation, generic, repeat } = e;
      s.events.push({ id: e.id, t, kind: "prompt", prompt: { chars, words, images, specific, observation, generic, repeat } });
    } else if (e.kind === "interrupt") {
      s.events.push({ id: e.id, t, kind: "interrupt" });
    } else {
      s.events.push({ id: e.id, t, kind: "agent", tools: e.kind === "tool" && e.tool ? [e.tool] : [] });
    }
  }
  if (!checkins.length) continue;
  people++;
  const sessions = [...bySession.values()];
  for (const s of sessions) s.events.sort((a, b) => a.t - b.t);
  const turns = sessions.length ? buildReport(sessions, { days: null }).flatMap((p) => p.sessions.flatMap((s) => s.turns)) : [];
  const humanTimes = turns.map((u) => u.t).sort((a, b) => a - b);
  const agentTimes = sessions.flatMap((s) => s.events.filter((e) => e.kind === "agent").map((e) => e.t)).sort((a, b) => a - b);
  const lastBefore = (list, t) => {
    let found = null;
    for (const x of list) if (x <= t) found = x;
    return found;
  };
  const covered = (t) => turns.some((u) => u.human > 0 && t <= u.t && t >= u.t - u.human * 1000);

  for (const c of checkins) {
    answers[c.answer] = (answers[c.answer] ?? 0) + 1;
    const human = lastBefore(humanTimes, c.t);
    const agent = lastBefore(agentTimes, c.t);
    if (human === null && agent === null) continue;
    let state;
    let since;
    if (agent !== null && (human === null || agent > human)) {
      since = (c.t - agent) / 60000;
      state = since < 0.5 ? 0 : 1;
    } else {
      since = (c.t - human) / 60000;
      state = 2;
    }
    const cell = table[state][binOf(since)];
    const onProject = c.answer === "project" || c.answer === "project-ai";
    const counted = covered(c.t);
    cell.n++;
    if (onProject) cell.project++;
    if (c.answer === "project-ai") cell.withAi++;
    if (c.answer === "none") cell.none++;
    if (counted) cell.counted++;
    if (onProject && counted) cell.projectCounted++;
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
console.log(`${people} people, ${Object.values(answers).reduce((a, b) => a + b, 0)} answers:`, answers);
for (const [s, rows] of table.entries()) {
  if (!rows.some((r) => r.n)) continue;
  console.log(`\n${STATES[s]}`);
  console.log("  time since        answers   on project   no answer   steer counted   on project and counted");
  rows.forEach((r, i) => {
    if (!r.n) return;
    console.log(
      `  ${binName(i).padEnd(16)}  ${String(r.n).padEnd(8)}  ${pct(r.project, r.n).padEnd(11)}  ${pct(r.none, r.n).padEnd(10)}  ${pct(r.counted, r.n).padEnd(14)}  ${pct(r.projectCounted, r.project)}`,
    );
  });
}

// The credit a gap of g minutes after the agent stops would get from these answers: the
// area under the "on project" share, a step per bin. Rough until each bin has 100+ answers.
const after = table[1];
const share = (i) => (after[i].n ? after[i].project / after[i].n : null);
const credit = (g) => {
  let total = 0;
  let from = 0;
  for (let i = 0; i < BINS.length && from < g; i++) {
    const to = Math.min(g, BINS[i]);
    const p = share(i);
    if (p === null) return null;
    total += p * (to - from);
    from = to;
  }
  return total;
};
const gaps = [5, 10, 20, 30, 60];
const credits = gaps.map((g) => credit(g));
console.log("\ncredit a gap after the agent stops would get from these answers (minutes):");
gaps.forEach((g, i) => console.log(`  ${String(g).padStart(2)} min gap -> ${credits[i] === null ? "not enough answers yet" : credits[i].toFixed(1)}`));
const thin = after.filter((r) => r.n > 0 && r.n < 30).length;
if (thin) console.log(`\n${thin} of the bins have under 30 answers, so treat these as rough.`);
