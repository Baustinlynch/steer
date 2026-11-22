// Load test: runs the real server (server/server.mjs) on a temp folder, sends it events
// the way steer clients do, and reports how it held up.
//
//   node tools/load/loadtest.mjs --users 800 --seconds 60
//   node tools/load/loadtest.mjs --users 50 --history 36000 --seconds 20
//
// --users     how many people are using an AI tool at the same moment
// --seconds   how long to send for
// --history   events already stored for each of those people (to see what loading a
//             long history costs), 0 by default
// --rate      events per active hour per person, default 300
//
// The numbers it sends come from real steer accounts (Nov 2026): 150 to 500 events per
// hour someone is active, 1 to 2 events per request because the hook sends right away,
// about 250 bytes per stored event.

import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(process.argv[i + 1]);
};
const USERS = arg("users", 800);
const SECONDS = arg("seconds", 60);
const HISTORY = arg("history", 0);
const RATE = arg("rate", 300);
const PORT = 18990;
const URL = `http://127.0.0.1:${PORT}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();

const data = mkdtempSync(join(tmpdir(), "steer-load-"));
mkdirSync(join(data, "events"));
const users = {};
for (let u = 0; u < USERS; u++) users[`u${u}`] = { keyHashes: [sha256(`key-${u}`)], created: "2026-11-01T00:00:00Z" };
writeFileSync(join(data, "users.json"), JSON.stringify(users));

/** One person's session: a prompt, the agent's tool calls, a stop, repeat. */
function makeEvent(u, n, t) {
  const step = n % 12;
  const base = { id: `${u}-${n}`, session: `s${u}-${Math.floor(n / 120)}`, project: `p${u % 5}`, via: "claude-code", t: iso(t) };
  if (step === 0) return { ...base, kind: "prompt", words: 30, chars: 160, images: 0, specific: 2, observation: false, generic: false, repeat: false };
  if (step === 11) return { ...base, kind: "stop" };
  return { ...base, kind: "tool", tool: "Edit" };
}

if (HISTORY > 0) {
  // Stored history, spread over the last 30 days, written like the server writes it.
  const start = Date.now() - 30 * 86400000;
  for (let u = 0; u < USERS; u++) {
    const out = createWriteStream(join(data, "events", `u${u}.jsonl`));
    for (let n = 0; n < HISTORY; n++) {
      const t = start + (n / HISTORY) * 30 * 86400000;
      const e = { ...makeEvent(u, n, t), id: `old-${u}-${n}`, got: iso(t), late: false };
      out.write(JSON.stringify(e) + "\n");
    }
    await new Promise((r) => out.end(r));
  }
}
const historyBytes = readdirSync(join(data, "events")).reduce((n, f) => n + statSync(join(data, "events", f)).size, 0);

const server = spawn("node", ["server/server.mjs"], { env: { ...process.env, PORT: String(PORT), STEER_DATA: data, PUBLIC_URL: URL }, stdio: ["ignore", "ignore", "inherit"] });
for (let i = 0; i < 100; i++) {
  try {
    await fetch(URL + "/");
    break;
  } catch {
    await sleep(100);
  }
}

// CPU and memory of the server, once a second (ps gives % of one core).
const samples = [];
const sampler = setInterval(() => {
  try {
    const [cpu, rss] = execSync(`ps -o %cpu=,rss= -p ${server.pid}`).toString().trim().split(/\s+/).map(Number);
    samples.push({ cpu, rss });
  } catch {}
}, 1000);

const latencies = [];
const sent = []; // { at, n } for each request, to measure the steady part
const statuses = {};
let events = 0;
let requests = 0;
const interval = 3600_000 / RATE; // ms between events for one person
const end = Date.now() + SECONDS * 1000;
const counters = new Array(USERS).fill(0);

async function person(u) {
  // Start at a random point, so the requests don't all line up.
  await sleep(Math.random() * interval);
  while (Date.now() < end) {
    const n = Math.random() < 0.7 ? 1 : 2; // 1 or 2 events per request
    const batch = [];
    for (let i = 0; i < n; i++) batch.push(makeEvent(u, counters[u]++, Date.now()));
    const a = performance.now();
    try {
      const res = await fetch(URL + "/api/events", {
        method: "POST",
        headers: { authorization: `Bearer key-${u}`, "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
      await res.arrayBuffer();
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    } catch (err) {
      statuses[err.cause?.code ?? "error"] = (statuses[err.cause?.code ?? "error"] ?? 0) + 1;
    }
    latencies.push(performance.now() - a);
    sent.push({ at: Date.now(), n });
    requests++;
    events += n;
    await sleep(Math.min(interval * n * (0.5 + Math.random()), Math.max(0, end - Date.now())));
  }
}

const startedAt = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, u) => person(u)));
// Steady part: after everyone has started, until the end.
const from = startedAt + interval;
const steady = sent.filter((r) => r.at >= from && r.at <= end);
const took = Math.max(1, (end - from) / 1000);

// A page for the person with the most history, first and second view.
const pageTimes = [];
for (let i = 0; i < 2; i++) {
  const a = performance.now();
  const res = await fetch(URL + "/u/u0");
  await res.text();
  pageTimes.push(Math.round(performance.now() - a));
}

clearInterval(sampler);
server.kill();
const storedBytes = readdirSync(join(data, "events")).reduce((n, f) => n + statSync(join(data, "events", f)).size, 0);
rmSync(data, { recursive: true, force: true });

latencies.sort((a, b) => a - b);
const q = (p) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]);
const busy = samples.slice(3); // skip start up
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(
  JSON.stringify(
    {
      people_at_once: USERS,
      history_events_each: HISTORY,
      seconds: Math.round(took),
      requests_per_sec: Math.round(steady.length / took),
      events_per_sec: Math.round(steady.reduce((n, r) => n + r.n, 0) / took),
      statuses,
      latency_ms: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(latencies[latencies.length - 1]) },
      server_cpu_pct_of_one_core: { avg: Math.round(avg(busy.map((s) => s.cpu))), max: Math.round(Math.max(...busy.map((s) => s.cpu))) },
      server_memory_mb: { max: Math.round(Math.max(...samples.map((s) => s.rss)) / 1024) },
      stored_bytes_per_event: Math.round((storedBytes - historyBytes) / Math.max(1, events)),
      page_ms_first_then_cached: pageTimes,
    },
    null,
    1,
  ),
);
