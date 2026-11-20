// steer server: takes events from the steer client while people work, stores them,
// and shows live profile and project pages. Uses the same counting code as the
// website (web/steer.js). No dependencies, just Node.
//
//   PORT=8790 STEER_DATA=./data node server/server.mjs
//
// Pages are worked out in a worker thread (this same file), so a big account can't
// hold up the events everyone else is sending.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import {
  buildReport,
  fmtDur,
  projectAgent,
  projectHuman,
  renderReport,
} from "../web/steer.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8790);
const DATA = process.env.STEER_DATA ?? join(here, "data");
const WEB = process.env.STEER_WEB ?? join(here, "..", "web");
// Events whose time is further than this from when the server got them don't count.
// That's what stops someone from making up old sessions later.
const LATE_SECS = 300;
// Events from further ahead than this don't count either. Clocks drift a bit, but
// nothing real happens in the future. They're still kept, so a person whose clock is
// wrong can see why time is missing.
const FUTURE_SECS = 30;
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "https://steer.duck.hackclub.app").replace(/\/$/, "");
// Sign in with Hack Club. Without these, the server falls back to name-only signup
// (handy for running your own).
const HCA =
  process.env.HCA_CLIENT_ID && process.env.HCA_CLIENT_SECRET
    ? { id: process.env.HCA_CLIENT_ID, secret: process.env.HCA_CLIENT_SECRET }
    : null;
const HCA_BASE = process.env.HCA_BASE ?? "https://auth.hackclub.com"; // changeable for tests
const HCA_SCOPES = "openid profile slack_id verification_status";

// ---------- limits ----------
// A busy day with a few agents running at once is about 5,000 events (prompts, tool
// calls and turn ends) and a busy minute about 130, so real use stays far under these.

const BODY_MAX = 1_000_000; // bytes in one request
const BATCH_MAX = 500; // events in one request, the client sends 500 at a time
const BURST = 5_000; // events one key can send at once, enough for a long offline queue
const REFILL = 2; // events per second a key gets back after that
const DAY_MAX = 20_000; // events stored per account per day (UTC, by when they arrived)
const REPORT_EVERY = 10_000; // ms, pages are worked out again at most this often
const STALE_WAIT = 1_500; // ms to wait for a new page before showing the last one
const PAGE_SESSIONS = 100; // sessions a project page shows
const PAGE_TURNS = 3_000; // rows across those sessions
const JOB_SECS = 30; // a page that takes longer is given up on for a while

// ---------- storage ----------

const usersFile = join(DATA, "users.json");
const eventsFile = (name) => join(DATA, "events", `${name}.jsonl`);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Accounts by name. No prototype, so names like "constructor" are just names. */
function loadUsers() {
  const users = Object.assign(Object.create(null), existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, "utf8")) : {});
  // Accounts used to have one key; now each device gets its own.
  for (const u of Object.values(users)) {
    if (u.keyHash && !u.keyHashes) {
      u.keyHashes = [u.keyHash];
      delete u.keyHash;
    }
  }
  return users;
}

if (isMainThread) mkdirSync(join(DATA, "events"), { recursive: true });
const users = isMainThread ? loadUsers() : Object.create(null);
const hasUser = (name) => name !== null && Object.hasOwn(users, name);
const byKey = new Map();
for (const [name, u] of Object.entries(users)) for (const h of u.keyHashes ?? []) byKey.set(h, name);

function saveUsers() {
  writeFileSync(usersFile + ".tmp", JSON.stringify(users, null, 1));
  renameSync(usersFile + ".tmp", usersFile);
}

/** Makes a new key for an account and returns it. Only its hash is stored. */
function addKey(name) {
  const key = randomBytes(24).toString("base64url");
  const hash = sha256(key);
  users[name].keyHashes = [...(users[name].keyHashes ?? []), hash];
  byKey.set(hash, name);
  saveUsers();
  return key;
}

/** Calls fn with each stored event of an account, reading the file bit by bit. */
async function eachEvent(name, fn) {
  const file = eventsFile(name);
  if (!existsSync(file)) return;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line cut off by a crash
    }
    fn(e);
  }
}

// What the main thread keeps per account: ids to skip repeats, and the few numbers
// the pages show next to the report. The events themselves stay on disk.
const stores = new Map(); // name -> { ready, store, used }
const STORE_IDLE = 30 * 60 * 1000;

function storeOf(name) {
  let s = stores.get(name);
  if (!s) {
    s = { ready: null, store: null, used: Date.now() };
    s.ready = loadStore(name).then((store) => (s.store = store));
    s.ready.catch(() => stores.delete(name));
    stores.set(name, s);
  }
  s.used = Date.now();
  return s.ready;
}

async function loadStore(name) {
  const store = { ids: new Set(), counted: 0, late: 0, last: null, vias: new Map(), day: "", today: 0 };
  await eachEvent(name, (e) => note(store, e));
  return store;
}

/** Adds one stored event to the numbers kept in memory. */
function note(store, e) {
  store.ids.add(e.id);
  if (e.late) store.late++;
  else store.counted++;
  if (!store.last || e.got > store.last) store.last = e.got;
  let vias = store.vias.get(e.project);
  if (!vias) store.vias.set(e.project, (vias = new Set()));
  vias.add(e.via ?? "claude-code");
  const day = String(e.got).slice(0, 10);
  if (day === store.day) store.today++;
  else if (day > store.day) {
    store.day = day;
    store.today = 1;
  }
}

// ---------- events ----------

const NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const clean = (s, max) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, "").slice(0, max) : "");
const KINDS = new Set(["prompt", "tool", "stop", "interrupt"]);
// The tools steer tracks. Only Codex and Copilot write down a stopped turn; the
// Claude Code and Cursor hooks and OpenCode never send an interrupt.
const VIAS = new Set(["claude-code", "cursor", "codex", "opencode", "copilot"]);
const INTERRUPTS = new Set(["codex", "copilot"]);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const LONGEST = 256; // strings longer than this didn't come from steer
// Upper bounds for prompt counts. Anything over these is made up.
const COUNTS = { words: 100_000, chars: 1_000_000, images: 100, specific: 100_002 };

/** Checks one event from a client. Returns the stored form or null. */
function accept(raw, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = raw.kind;
  if (!KINDS.has(kind)) return null;
  for (const k of ["id", "session", "project", "tool"]) {
    const v = raw[k];
    if (v != null && (typeof v !== "string" || v.length > LONGEST)) return null;
  }
  // Clients from before Codex support didn't send via.
  const via = raw.via ?? "claude-code";
  if (!VIAS.has(via)) return null;
  if (kind === "interrupt" && !INTERRUPTS.has(via)) return null;
  const t = typeof raw.t === "string" && TIME.test(raw.t) ? Date.parse(raw.t) : NaN;
  if (Number.isNaN(t)) return null;
  const id = clean(raw.id, 64);
  const session = clean(raw.session, 100);
  if (!id || !session) return null;

  const e = {
    id,
    session,
    project: clean(raw.project, 100) || "unknown",
    via,
    kind,
    t: new Date(t).toISOString(),
    got: new Date(now).toISOString(),
    late: now - t > LATE_SECS * 1000 || t - now > FUTURE_SECS * 1000,
  };
  if (kind === "prompt") {
    const n = {};
    for (const [k, max] of Object.entries(COUNTS)) {
      const v = raw[k] ?? 0;
      if (!Number.isInteger(v) || v < 0 || v > max) return null;
      n[k] = v;
    }
    // Every word has a letter in it, and "specific" counts words plus at most two extras.
    if (n.words > n.chars || n.specific > n.words + 2) return null;
    for (const k of ["observation", "generic", "repeat"]) if (raw[k] != null && typeof raw[k] !== "boolean") return null;
    e.words = n.words;
    e.chars = n.chars;
    e.images = n.images;
    e.specific = n.specific;
    e.observation = raw.observation === true;
    e.generic = raw.generic === true;
    e.repeat = raw.repeat === true;
  }
  if (kind === "tool") e.tool = clean(raw.tool, 80);
  return e;
}

/** Turns stored events into the sessions shape web/steer.js works with. Late events are left out. */
async function sessionsOf(name) {
  const bySession = new Map();
  await eachEvent(name, (e) => {
    if (e.late) return;
    let s = bySession.get(e.session);
    if (!s) {
      s = { path: e.session, cwd: e.project, title: null, events: [] };
      bySession.set(e.session, s);
    }
    const t = Date.parse(e.t);
    if (e.kind === "prompt") {
      const prompt = {
        chars: e.chars,
        words: e.words,
        images: e.images,
        specific: e.specific,
        observation: e.observation,
        generic: e.generic,
        repeat: e.repeat,
      };
      s.events.push({ id: e.id, t, kind: "prompt", prompt });
    } else if (e.kind === "interrupt") {
      s.events.push({ id: e.id, t, kind: "interrupt" });
    } else {
      s.events.push({ id: e.id, t, kind: "agent", tools: e.kind === "tool" && e.tool ? [e.tool] : [] });
    }
  });
  const sessions = [...bySession.values()];
  for (const s of sessions) s.events.sort((a, b) => a.t - b.t);
  return sessions;
}

// ---------- rate limits ----------

/** Token buckets: each key (an account key or an IP) can spend `size` at once and gets `perSec` back. */
class Buckets {
  constructor(size, perSec, max = 100_000) {
    this.size = size;
    this.perSec = perSec;
    this.max = max;
    this.map = new Map();
  }

  bucket(key, now) {
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.max) this.sweep(now, true);
      b = { tokens: this.size, at: now };
      this.map.set(key, b);
    }
    b.tokens = Math.min(this.size, b.tokens + ((now - b.at) / 1000) * this.perSec);
    b.at = now;
    return b;
  }

  has(key, n = 1, now = Date.now()) {
    return this.bucket(key, now).tokens >= n;
  }

  /** Spends n if there's that much. A failed try still costs 1, so hammering doesn't help. */
  take(key, n = 1, now = Date.now()) {
    const b = this.bucket(key, now);
    if (b.tokens >= n) {
      b.tokens -= n;
      return true;
    }
    b.tokens = Math.max(0, b.tokens - 1);
    return false;
  }

  /** Seconds until n can be spent. */
  wait(key, n = 1, now = Date.now()) {
    return Math.max(1, Math.ceil((n - this.bucket(key, now).tokens) / this.perSec));
  }

  /** Forgets full buckets, they'd start full anyway. When there are too many, the oldest go. */
  sweep(now = Date.now(), full = false) {
    for (const [k, b] of this.map) if (b.tokens + ((now - b.at) / 1000) * this.perSec >= this.size) this.map.delete(k);
    if (full) for (const k of [...this.map.keys()].slice(0, Math.ceil(this.max / 10))) this.map.delete(k);
  }
}

const sendLimit = new Buckets(BURST, REFILL); // per account key
const loginStarts = new Buckets(20, 1 / 30); // per IP: 20 logins, then one every 30 s
const codeTries = new Buckets(20, 1 / 30); // per IP, typing the code from the terminal
const signups = new Buckets(10, 1 / 360); // per IP: 10, then one every 6 minutes

// Proxies whose X-Forwarded-For is believed: this machine, plus TRUSTED_PROXIES (comma
// separated). On Nest the proxy isn't on this machine, it connects from 10.60.1.2, so
// that address goes in TRUSTED_PROXIES there.
const TRUSTED = new Set(["127.0.0.1", "::1", ...(process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
const trusted = (ip) => TRUSTED.has(ip) || (ip.startsWith("::ffff:") && TRUSTED.has(ip.slice(7)));

/**
 * Who's asking, for the per-IP limits. Behind a proxy every connection comes from the
 * proxy, which puts the real address last in X-Forwarded-For. That header is only
 * believed from a trusted proxy, anyone else could make it up. IPv6 addresses are
 * grouped by /64, since one person usually has a whole /64.
 */
function clientIp(req) {
  let ip = req.socket.remoteAddress ?? "";
  const fwd = req.headers["x-forwarded-for"];
  if (trusted(ip) && typeof fwd === "string" && fwd.trim()) ip = fwd.split(",").at(-1).trim().slice(0, 64);
  if (ip.startsWith("::ffff:") && ip.includes(".")) return ip.slice(7);
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("%")[0].toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// ---------- the report worker ----------

/** A page couldn't be worked out right now. */
class Busy extends Error {}

let worker = null;
const jobs = new Map(); // id -> { resolve, reject, timer, name }, oldest first
let lastJob = 0;
const tooBig = new Map(); // name -> ms until its pages are tried again

function startWorker() {
  // A report that needs more memory than this stops the worker, not the server.
  const w = new Worker(new URL(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
  w.on("message", ({ id, result, error }) => {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    clearTimeout(job.timer);
    if (error) job.reject(new Busy(error));
    else job.resolve(result);
  });
  const gone = (err) => {
    if (worker === w) stopWorker(err?.message ?? "it stopped");
  };
  w.on("error", gone);
  w.on("exit", gone);
  worker = w;
}

/** Stops the worker and fails what's waiting on it. Jobs run in order, so the oldest one was running. */
function stopWorker(why) {
  const w = worker;
  worker = null;
  w?.terminate();
  const running = jobs.values().next().value;
  if (running) tooBig.set(running.name, Date.now() + 10 * 60 * 1000);
  for (const job of jobs.values()) {
    clearTimeout(job.timer);
    job.reject(new Busy(why));
  }
  jobs.clear();
  console.error("report worker stopped:", why);
}

function work(msg) {
  if ((tooBig.get(msg.name) ?? 0) > Date.now()) return Promise.reject(new Busy("too big for now"));
  if (jobs.size >= 200) return Promise.reject(new Busy("too many pages at once"));
  if (!worker) startWorker();
  const id = ++lastJob;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopWorker(`${msg.name}'s page took over ${JOB_SECS}s`), JOB_SECS * 1000);
    jobs.set(id, { resolve, reject, timer, name: msg.name });
    worker.postMessage({ id, ...msg });
  });
}

/** The worker side: works out reports and renders them, one job at a time. */
function workerMain() {
  const kept = new Map(); // name -> { version, projects }, the last few accounts
  let queue = Promise.resolve();
  parentPort.on("message", (msg) => {
    queue = queue
      .then(() => job(msg))
      .then(
        (result) => parentPort.postMessage({ id: msg.id, result }),
        (err) => parentPort.postMessage({ id: msg.id, error: String(err?.message ?? err) }),
      );
  });

  async function projectsOf(name, version) {
    let r = kept.get(name);
    if (!r || r.version !== version) r = { version, projects: buildReport(await sessionsOf(name), { days: null }) };
    kept.delete(name);
    kept.set(name, r);
    if (kept.size > 3) kept.delete(kept.keys().next().value);
    return r.projects;
  }

  async function job({ op, name, version, project }) {
    const projects = await projectsOf(name, version);
    if (op === "report") {
      return {
        profile: projects.length
          ? renderReport(projects, {
              window: "all time",
              source: "events the steer client sent while working",
              sessions: false,
              projectLink: (p) => `/u/${encodeURIComponent(name)}/${encodeURIComponent(p)}`,
            })
          : "",
        hours: projects.map((p) => ({
          name: p.name,
          sessions: p.sessions.length,
          your_secs: projectHuman(p),
          agent_secs: projectAgent(p),
          your_time: fmtDur(projectHuman(p)),
        })),
      };
    }
    const p = projects.find((x) => x.name === project);
    return p ? projectHtml(p) : null;
  }
}

/** A project's report. Only the newest sessions get drawn, the totals count all of them. */
function projectHtml(p) {
  const opts = { window: "all time", source: "events the steer client sent while working" };
  let shown = 0;
  let rows = 0;
  for (const s of p.sessions) {
    if (shown > 0 && (shown >= PAGE_SESSIONS || rows + s.turns.length > PAGE_TURNS)) break;
    shown++;
    rows += s.turns.length;
  }
  if (shown === p.sessions.length) return renderReport([p], opts);
  const note = `<p class="muted">Showing the newest ${shown} of ${p.sessions.length} sessions.</p>\n`;
  const totals = renderReport([p], { ...opts, sessions: false });
  const part = renderReport([{ ...p, sessions: p.sessions.slice(0, shown) }], { ...opts, checks: false });
  const at = part.indexOf("<h2>Sessions</h2>");
  if (at < 0) return totals + note;
  // The project heading in that part only adds up the sessions shown, so it goes.
  return totals + part.slice(at).replace(/<h3>[^\n]*<\/h3>\n/, note);
}

// ---------- page cache ----------

/** Least recently used first, dropped once they add up to more than maxBytes. */
class Lru {
  constructor(maxBytes) {
    this.max = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, v, size) {
    this.delete(key);
    v.size = size;
    this.map.set(key, v);
    this.bytes += size;
    while (this.bytes > this.max && this.map.size > 1) this.delete(this.map.keys().next().value);
  }
  delete(key) {
    const v = this.map.get(key);
    if (v) {
      this.bytes -= v.size;
      this.map.delete(key);
    }
  }
}

const pages = new Lru(64 * 1024 * 1024); // key -> { version, at, value }
const working = new Map(); // key -> promise

/**
 * Something the worker makes, kept until new events arrive for that account, and
 * then still for REPORT_EVERY. If an older copy exists and the new one is slow, the
 * older one is shown.
 */
function cached(key, name, store, msg, sizeOf) {
  const hit = pages.get(key);
  if (hit && (hit.version === store.counted || Date.now() - hit.at < REPORT_EVERY)) return Promise.resolve(hit.value);
  let p = working.get(key);
  if (!p) {
    const version = store.counted;
    p = work({ ...msg, name, version })
      .then((value) => {
        pages.set(key, { version, at: Date.now(), value }, sizeOf(value) + key.length + 64);
        return value;
      })
      .finally(() => working.delete(key));
    working.set(key, p);
  }
  if (!hit) return p;
  return Promise.race([p.catch(() => hit.value), new Promise((ok) => setTimeout(() => ok(hit.value), STALE_WAIT))]);
}

const reportOf = (name, store) =>
  store.counted === 0
    ? Promise.resolve({ profile: "", hours: [] })
    : cached(`r\n${name}`, name, store, { op: "report" }, (v) => v.profile.length + JSON.stringify(v.hours).length);

const projectOf = (name, store, project) =>
  cached(`p\n${name}\n${project}`, name, store, { op: "project", project }, (v) => v?.length ?? 0);

// ---------- http ----------

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/steer.js": ["steer.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/install.sh": ["install.sh", "text/plain; charset=utf-8"],
  "/install.ps1": ["install.ps1", "text/plain; charset=utf-8"],
};

const PAGE_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
// The login form posts here and then goes on to Hack Club.
const LOGIN_CSP = PAGE_CSP.replace("form-action 'none'", `form-action 'self' ${new URL(HCA_BASE).origin}`);

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), "application/json", extra);
const tooMany = (res, secs, error) => json(res, 429, { error }, { "retry-after": String(secs) });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(res, title, body, { refresh, status = 200, csp = PAGE_CSP } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">\n` : ""}<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
  send(res, status, html, "text/html; charset=utf-8", { "content-security-policy": csp });
}

const TOO_BIG = Symbol("too big");

/** The request body as text, or TOO_BIG once it goes over limit. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) return resolve(TOO_BIG);
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners("data");
        resolve(TOO_BIG);
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req, limit) {
  const body = await readBody(req, limit);
  if (body === TOO_BIG) return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Answers 413 and hangs up instead of reading the rest. */
function tooLarge(req, res) {
  res.on("finish", () => req.destroy());
  json(res, 413, { error: `requests can be at most ${BODY_MAX} bytes` }, { connection: "close" });
}

function keyOf(req) {
  const m = /^Bearer (\S{1,200})$/.exec(req.headers.authorization ?? "");
  return m ? sha256(m[1]) : null;
}
function userFromKey(req) {
  const h = keyOf(req);
  return h ? byKey.get(h) ?? null : null;
}

/** decodeURIComponent, or null for a broken % escape. */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

async function profilePage(res, name) {
  const store = await storeOf(name);
  const report = await reportOf(name, store);
  const hc = users[name].hc;
  const linked = hc
    ? `Linked to a Hack Club account${hc.verification_status === "verified" ? " (verified)" : ""}.`
    : "Not linked to a Hack Club account.";
  let body = `<h1>steer · ${esc(name)}</h1>
<p class="muted">Live. This page reloads every 30 seconds. ${store.last ? `Last activity ${esc(new Date(store.last).toUTCString())}.` : "Nothing tracked yet."} ${linked}</p>
`;
  body += report.profile;
  const late = store.late;
  if (late) {
    const what = late === 1 ? "1 event has a time" : `${late} events have times`;
    body += `<p class="muted">${what} too far from when the server got them, so they aren't counted. Usually that means they were sent more than 5 minutes late, or this computer's clock is wrong.</p>\n`;
  }
  page(res, `steer · ${name}`, body, { refresh: 30 });
}

async function projectPage(res, name, project) {
  const store = await storeOf(name);
  const report = await reportOf(name, store);
  const html = report.hours.some((p) => p.name === project) ? await projectOf(name, store, project) : null;
  if (html == null) return send(res, 404, "No such project");
  const tools = [...(store.vias.get(project) ?? [])];
  const body = `<h1><a href="/u/${encodeURIComponent(name)}">${esc(name)}</a> / ${esc(project)}</h1>
<p class="muted">Tracked from ${esc(tools.join(", "))}.</p>
${html}`;
  page(res, `${project} · steer`, body);
}

async function hoursJson(res, name, project) {
  const store = await storeOf(name);
  const projects = (await reportOf(name, store)).hours.filter((p) => !project || p.name === project);
  if (project && !projects.length) return json(res, 404, { error: "no such project" });
  const hc = users[name].hc;
  json(res, 200, {
    user: name,
    // So programs can match hours to the person who submitted. Null if not linked.
    hackclub: hc ? { slack_id: hc.slack_id, verification_status: hc.verification_status, ysws_eligible: hc.ysws_eligible } : null,
    projects,
  });
}

// ---------- sign in with Hack Club ----------
// The terminal asks for a login code, opens /login?code=..., and polls until the
// browser side is done. The terminal also prints a short user code, and the page only
// goes on once that code is typed in. So a login link someone else started is no use
// to them: whoever opens it doesn't have their terminal.

const LOGIN_TTL = 10 * 60 * 1000;
const LOGINS_MAX = 5_000; // logins waiting at once
const CODE_TRIES = 5; // wrong codes before a login is thrown away
const logins = new Map(); // login code -> { userCode, created, link, state, tries, result }
const byState = new Map(); // oauth state -> login code, at most one per login

function dropLogin(code) {
  const l = logins.get(code);
  if (l?.state) byState.delete(l.state);
  logins.delete(code);
}

function sweepLogins() {
  const now = Date.now();
  for (const [code, l] of logins) if (now - l.created > LOGIN_TTL) dropLogin(code);
}

/** The account this login would link a Hack Club account to, if any. */
const linkTarget = (l) => (l.link && hasUser(l.link) && !users[l.link].hc ? l.link : null);

const gonePage = (res, status = 200) =>
  page(res, "steer login", `<h1>steer</h1>\n<p>This login link expired. Run <code>steer login</code> again.</p>`, { status });

function loginPage(res, code, { error, status = 200 } = {}) {
  const l = logins.get(code);
  if (!l) return gonePage(res, status);
  if (l.result) return page(res, "steer login", `<h1>steer</h1>\n<p>This login is done. Go back to your terminal.</p>`);
  const link = linkTarget(l);
  const what = link
    ? `<p>The terminal that started this uses the steer account <b>${esc(link)}</b>. If your Hack Club account isn't on steer yet, it gets linked to ${esc(link)}.</p>`
    : `<p>If your Hack Club account is already on steer, you sign in to that account. If not, you get a new one.</p>`;
  page(
    res,
    "steer login",
    `<h1>Sign in to steer</h1>
<p>Type the code your terminal shows after "your code":</p>
<form method="post" action="/login/go">
<input type="hidden" name="code" value="${esc(code)}">
<p><input name="user_code" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="XXXX-XXXX" style="font:bold 20px Menlo,Consolas,monospace;letter-spacing:2px;width:8em;padding:4px 6px;border:1px solid #000;border-radius:0">
<button>Continue with Hack Club</button></p>
</form>
${error ? `<p class="red">${error}</p>\n` : ""}${what}
<p class="muted">Only do this if you just ran steer login on your own computer. That terminal gets signed in as you. If someone sent you this link or told you what to type, close this page.</p>`,
    { csp: LOGIN_CSP, status },
  );
}

function sameCode(typed, userCode) {
  const a = Buffer.from(String(typed ?? "").toUpperCase().replace(/[^0-9A-Z]/g, ""));
  const b = Buffer.from(userCode.replace(/-/g, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True unless a browser says the form was sent from another site. */
function fromHere(req) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  return origin === new URL(PUBLIC_URL).origin || origin === `https://${host}` || origin === `http://${host}`;
}

/** The form on the login page: checks the typed code, then off to Hack Club. */
async function loginGo(req, res) {
  if (!codeTries.take(clientIp(req))) {
    return page(res, "steer login", `<h1>steer</h1>\n<p>Too many tries from here. Wait a few minutes and try again.</p>`, { status: 429 });
  }
  if (!fromHere(req)) return send(res, 403, "This form only works from the steer login page.");
  const body = await readBody(req, 10_000);
  if (body === TOO_BIG) return tooLarge(req, res);
  const form = new URLSearchParams(body);
  const code = form.get("code") ?? "";
  const l = logins.get(code);
  if (!l || !HCA) return gonePage(res, 400);
  if (l.result) return loginPage(res, code);
  if (!sameCode(form.get("user_code"), l.userCode)) {
    l.tries = (l.tries ?? 0) + 1;
    if (l.tries >= CODE_TRIES) {
      dropLogin(code);
      return page(res, "steer login", `<h1>steer</h1>\n<p>That was the wrong code too many times. Run <code>steer login</code> again.</p>`, { status: 400 });
    }
    return loginPage(res, code, { error: "That code doesn't match. Check your terminal and try again.", status: 400 });
  }
  if (l.state) byState.delete(l.state);
  l.state = randomBytes(16).toString("base64url");
  byState.set(l.state, code);
  const q = new URLSearchParams({
    client_id: HCA.id,
    redirect_uri: `${PUBLIC_URL}/auth/callback`,
    response_type: "code",
    scope: HCA_SCOPES,
    state: l.state,
  });
  res.writeHead(303, { location: `${HCA_BASE}/oauth/authorize?${q}` });
  res.end();
}

/** A free profile name based on someone's Hack Club nickname. */
function freeName(raw) {
  let base = String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 28);
  if (!NAME.test(base)) base = "hackclubber";
  let name = base;
  for (let i = 2; hasUser(name); i++) name = `${base}-${i}`;
  return name;
}

async function authCallback(res, authCode, state) {
  const code = byState.get(state);
  const l = code && logins.get(code);
  if (!l || !HCA || !authCode) {
    return page(res, "steer login", `<h1>steer</h1>\n<p>This login didn't work or expired. Run <code>steer login</code> again.</p>`);
  }
  byState.delete(state);
  l.state = null;
  let info;
  try {
    const tokenRes = await fetch(`${HCA_BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: HCA.id,
        client_secret: HCA.secret,
        redirect_uri: `${PUBLIC_URL}/auth/callback`,
        code: authCode,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();
    const infoRes = await fetch(`${HCA_BASE}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!infoRes.ok) throw new Error(`userinfo ${infoRes.status}`);
    info = await infoRes.json();
  } catch (err) {
    console.error("hack club login failed:", err.message);
    return page(res, "steer login", `<h1>steer</h1>\n<p>Hack Club didn't confirm the login. Run <code>steer login</code> again.</p>`);
  }
  if (!info?.sub) return page(res, "steer login", `<h1>steer</h1>\n<p>Hack Club didn't send an account id.</p>`);

  // Same Hack Club account as before, or link the account the terminal was already
  // using, or make a new one.
  const now = new Date().toISOString();
  let name = Object.keys(users).find((n) => users[n].hc?.sub === info.sub);
  if (!name) name = linkTarget(l);
  if (!name) {
    name = freeName(info.nickname || info.given_name || info.name);
    users[name] = { keyHashes: [], created: now };
  }
  // Only what programs need to match hours to people. No email, name or address.
  users[name].hc = {
    sub: info.sub,
    slack_id: info.slack_id ?? null,
    verification_status: info.verification_status ?? null,
    ysws_eligible: info.ysws_eligible ?? null,
    updated: now,
  };
  l.result = { name, key: addKey(name) };
  page(
    res,
    "steer login",
    `<h1>Signed in as ${esc(name)}</h1>
<p>Go back to your terminal, it finishes by itself. You can close this tab.</p>
<p><a href="/u/${encodeURIComponent(name)}">Your page</a></p>`,
  );
}

// ---------- requests ----------

function secsToMidnight(now) {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

async function postEvents(req, res) {
  const key = keyOf(req);
  const name = key && byKey.get(key);
  if (!name) return json(res, 401, { error: "bad key" });
  const slow = "too many events at once, the rest can come in a bit";
  if (!sendLimit.has(key)) return tooMany(res, sendLimit.wait(key), slow);
  const body = await readJson(req, BODY_MAX);
  const bad = body === TOO_BIG || !Array.isArray(body?.events) || body.events.length > BATCH_MAX;
  if (bad) sendLimit.take(key, 1); // so sending junk over and over runs out too
  if (body === TOO_BIG) return tooLarge(req, res);
  if (!Array.isArray(body?.events)) return json(res, 400, { error: "send {events: [...]}" });
  if (body.events.length > BATCH_MAX) return json(res, 413, { error: `send at most ${BATCH_MAX} events at a time` });
  const cost = Math.max(1, body.events.length);
  if (!sendLimit.take(key, cost)) return tooMany(res, sendLimit.wait(key, cost), slow);

  const now = Date.now();
  const store = await storeOf(name);
  const fresh = [];
  const ids = new Set();
  let dropped = 0;
  for (const raw of body.events) {
    const e = accept(raw, now);
    if (!e) dropped++;
    else if (!store.ids.has(e.id) && !ids.has(e.id)) {
      ids.add(e.id);
      fresh.push(e);
    }
  }
  const day = new Date(now).toISOString().slice(0, 10);
  if (store.day !== day) {
    store.day = day;
    store.today = 0;
  }
  if (fresh.length && store.today + fresh.length > DAY_MAX) {
    return tooMany(res, secsToMidnight(now), `this account sent ${DAY_MAX} events today, the rest has to wait until tomorrow (utc)`);
  }
  if (fresh.length) {
    appendFileSync(eventsFile(name), fresh.map((e) => JSON.stringify(e) + "\n").join(""));
    for (const e of fresh) note(store, e);
  }
  return json(res, 200, { accepted: fresh.length, late: fresh.filter((e) => e.late).length, dropped });
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch {
    return send(res, 400, "Bad request");
  }
  const path = url.pathname;
  let m;

  if (req.method === "GET" && Object.hasOwn(STATIC, path)) {
    const [file, type] = STATIC[path];
    return send(res, 200, readFileSync(join(WEB, file)), type);
  }

  if (req.method === "POST" && path === "/api/signup") {
    if (HCA) return json(res, 410, { error: "this server uses hack club accounts, run steer login instead" });
    if (!signups.has(clientIp(req))) return tooMany(res, signups.wait(clientIp(req)), "too many new accounts from here, try again later");
    const body = await readJson(req, 10_000);
    if (body === TOO_BIG) return tooLarge(req, res);
    const name = typeof body?.name === "string" ? body.name.toLowerCase() : "";
    if (!NAME.test(name)) return json(res, 400, { error: "names are 2-32 letters, numbers, - or _" });
    if (hasUser(name)) return json(res, 409, { error: "that name is taken" });
    signups.take(clientIp(req));
    users[name] = { keyHashes: [], created: new Date().toISOString() };
    return json(res, 201, { name, key: addKey(name) });
  }

  // ----- sign in with Hack Club -----
  if (req.method === "POST" && path === "/api/cli-login") {
    if (!HCA) return json(res, 503, { error: "this server doesn't have hack club login set up, use steer signup" });
    const ip = clientIp(req);
    if (!loginStarts.take(ip)) return tooMany(res, loginStarts.wait(ip), "too many logins from here, wait a few minutes");
    sweepLogins();
    if (logins.size >= LOGINS_MAX) return json(res, 503, { error: "too many people are logging in right now, try again in a few minutes" }, { "retry-after": "60" });
    const code = randomBytes(16).toString("base64url");
    const hex = randomBytes(4).toString("hex").toUpperCase();
    const userCode = `${hex.slice(0, 4)}-${hex.slice(4)}`;
    logins.set(code, { userCode, created: Date.now(), link: userFromKey(req), state: null, tries: 0, result: null });
    return json(res, 200, { code, user_code: userCode, url: `${PUBLIC_URL}/login?code=${code}` });
  }
  if (req.method === "GET" && (m = /^\/api\/cli-login\/([A-Za-z0-9_-]+)$/.exec(path))) {
    const l = logins.get(m[1]);
    if (!l) return json(res, 404, { status: "expired" });
    if (!l.result) return json(res, 200, { status: "pending" });
    dropLogin(m[1]);
    return json(res, 200, { status: "done", ...l.result });
  }
  if (req.method === "GET" && path === "/login") return loginPage(res, url.searchParams.get("code") ?? "");
  if (path === "/login/go") {
    if (req.method === "POST") return loginGo(req, res);
    // Old links and anyone skipping the code go back to the page that asks for it.
    res.writeHead(303, { location: `/login?code=${encodeURIComponent(url.searchParams.get("code") ?? "")}` });
    return res.end();
  }
  if (req.method === "GET" && path === "/auth/callback") {
    return authCallback(res, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
  }

  if (req.method === "POST" && path === "/api/events") return postEvents(req, res);

  if (req.method === "GET" && (m = /^\/u\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path))) {
    const name = decode(m[1]);
    const project = m[2] === undefined ? undefined : decode(m[2]);
    if (name === null || project === null) return send(res, 400, "Bad path");
    if (!hasUser(name)) return send(res, 404, "No such user");
    return project === undefined ? profilePage(res, name) : projectPage(res, name, project);
  }
  if (req.method === "GET" && (m = /^\/api\/u\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path))) {
    const name = decode(m[1]);
    const project = m[2] === undefined ? null : decode(m[2]);
    if (name === null || (project === null && m[2] !== undefined)) return json(res, 400, { error: "bad path" });
    if (!hasUser(name)) return json(res, 404, { error: "no such user" });
    return hoursJson(res, name, project);
  }

  send(res, 404, "Not found");
}

/** Every minute: forget expired logins, full buckets and accounts nobody used for a while. */
function sweep() {
  const now = Date.now();
  sweepLogins();
  for (const b of [sendLimit, loginStarts, codeTries, signups]) b.sweep(now);
  for (const [name, until] of tooBig) if (until < now) tooBig.delete(name);
  for (const [name, s] of stores) if (s.store && now - s.used > STORE_IDLE) stores.delete(name);
}

if (isMainThread) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof Busy) {
        const msg = "This page is busy, try again in a minute.";
        return req.url.startsWith("/api/")
          ? json(res, 503, { error: msg }, { "retry-after": "60" })
          : send(res, 503, msg, undefined, { "retry-after": "60" });
      }
      console.error(err);
      send(res, 500, "Something broke");
    });
  });
  // Slow senders don't get to hold a connection open for long.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  setInterval(sweep, 60_000).unref();
  server.listen(PORT, () => console.log(`steer server on :${PORT}, data in ${DATA}`));
} else {
  workerMain();
}
