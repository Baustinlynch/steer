// Compares what tools/truth.sh asked you ("what are you doing right now?") with what
// steer counted at those same moments, from your Claude Code logs on this computer.
// Prints counts only, nothing is sent anywhere.
//   node tools/truth-compare.mjs [answers.jsonl] [claude projects folder] [--detail]

import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionReader, buildReport, fmtDur } from "../web/steer.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const detail = process.argv.includes("--detail");
const answersFile = args[0] ?? join(here, "..", "truth", "answers.jsonl");
const root = args[1] ?? join(homedir(), ".claude", "projects");

// ---------- your answers ----------

const lines = readFileSync(answersFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const samples = [];
const runs = [];
for (const l of lines) {
  const t = Date.parse(l.t);
  if (l.event === "start") runs.push({ start: t, end: null });
  else if (l.event === "stop" && runs.length) runs[runs.length - 1].end = t;
  else if (l.answer) samples.push({ t, answer: l.answer });
}
// A run that was never stopped (closed terminal) ends at its last answer.
for (const r of runs) {
  if (r.end === null) r.end = Math.max(r.start, ...samples.filter((s) => s.t >= r.start).map((s) => s.t));
}
if (!samples.length) {
  console.log("no answers yet. run sh tools/truth.sh while you work, then try again.");
  process.exit(0);
}
const WORKING = "working with the ai";

// ---------- what steer counted ----------

const sessions = [];
for (const dir of readdirSync(root)) {
  const folder = join(root, dir);
  if (!statSync(folder).isDirectory()) continue;
  for (const name of readdirSync(folder)) {
    const file = join(folder, name);
    if (!name.endsWith(".jsonl") || !statSync(file).isFile()) continue;
    const reader = new SessionReader(`projects/${dir}/${name}`);
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) reader.line(line);
    const s = reader.finish();
    if (s) sessions.push(s);
  }
}
const turns = buildReport(sessions, { days: null }).flatMap((p) => p.sessions.flatMap((s) => s.turns));
turns.sort((a, b) => a.t - b.t);
// Each turn's time covers the stretch right before it.
const covered = (t) => turns.some((u) => u.human > 0 && t <= u.t && t >= u.t - u.human * 1000);
// The turn whose gap a moment falls in: the first one at or after it.
const turnAfter = (t) => turns.find((u) => u.t >= t) ?? null;
const gapOf = (u) => (u?.why?.gap ?? u?.why?.wall ?? null);
const bucket = (s) => (s === null ? "no gap" : s < 120 ? "under 2m" : s < 600 ? "2 to 10m" : s < 1200 ? "10 to 20m" : s < 3600 ? "20 to 60m" : "over 1h");

// ---------- compare ----------

const labels = [...new Set(samples.map((s) => s.answer))];
const table = Object.fromEntries(labels.map((l) => [l, { counted: 0, not: 0 }]));
const misses = { missed: new Map(), extra: new Map() };
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
for (const s of samples) {
  const c = covered(s.t);
  table[s.answer][c ? "counted" : "not"]++;
  const u = turnAfter(s.t);
  const why = u ? `${u.darkFlow ? "darkflow" : u.why.rule}, gap ${bucket(gapOf(u))}` : "no turn after it";
  if (s.answer === WORKING && !c) bump(misses.missed, why);
  if (s.answer !== WORKING && c) bump(misses.extra, why);
  if (detail) console.log(new Date(s.t).toISOString(), s.answer.padEnd(20), c ? "counted" : "not counted", "|", why);
}

console.log(`\n${samples.length} answers over ${runs.length} work sessions\n`);
console.log("you said              steer counted   steer didn't");
for (const [l, r] of Object.entries(table)) console.log(`${l.padEnd(22)}${String(r.counted).padEnd(16)}${r.not}`);

// Totals over the time the script was running.
const inRuns = (t) => runs.some((r) => t >= r.start && t <= r.end);
const runSecs = runs.reduce((n, r) => n + (r.end - r.start) / 1000, 0);
let steerSecs = 0;
for (const r of runs) {
  // Count covered seconds a minute at a time, which is close enough here.
  for (let t = r.start; t < r.end; t += 60_000) if (covered(t)) steerSecs += 60;
}
let estSecs = 0;
for (const r of runs) {
  const own = samples.filter((s) => s.t >= r.start && s.t <= r.end);
  if (own.length) estSecs += ((r.end - r.start) / 1000) * (own.filter((s) => s.answer === WORKING).length / own.length);
}
const agentSecs = turns.filter((u) => inRuns(u.t)).reduce((n, u) => n + u.agent, 0);
console.log(`\nwhile the script ran (${fmtDur(Math.round(runSecs))}):`);
console.log(`  you working with the ai, from your answers   about ${fmtDur(Math.round(estSecs))}`);
console.log(`  steer counted                                ${fmtDur(steerSecs)}`);
console.log(`  1/3 rule                                     ${fmtDur(Math.round(agentSecs / 3))}`);

const show = (title, m) => {
  if (!m.size) return;
  console.log(`\n${title}`);
  for (const [k, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
};
show("you were working but steer didn't count it (rule of the next prompt, and its gap):", misses.missed);
show("steer counted it but you weren't working with the ai:", misses.extra);
console.log(`\nwith ${samples.length} answers these are rough. a few hundred makes them solid.`);
