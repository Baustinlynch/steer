// steer server: takes events from the steer client while people work, stores them,
// and shows live profile and project pages. Uses the same counting code as the
// website (web/steer.js). No dependencies, just Node.
//
//   PORT=8790 STEER_DATA=./data node server/server.mjs

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "https://steer.duck.hackclub.app").replace(/\/$/, "");
// Sign in with Hack Club. Without these, the server falls back to name-only signup
// (handy for running your own).
const HCA =
  process.env.HCA_CLIENT_ID && process.env.HCA_CLIENT_SECRET
    ? { id: process.env.HCA_CLIENT_ID, secret: process.env.HCA_CLIENT_SECRET }
    : null;
const HCA_BASE = process.env.HCA_BASE ?? "https://auth.hackclub.com"; // changeable for tests
const HCA_SCOPES = "openid profile slack_id verification_status";

mkdirSync(join(DATA, "events"), { recursive: true });

// ---------- storage ----------

const usersFile = join(DATA, "users.json");
const users = existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, "utf8")) : {};
// Accounts used to have one key; now each device gets its own.
for (const u of Object.values(users)) {
  if (u.keyHash && !u.keyHashes) {
    u.keyHashes = [u.keyHash];
    delete u.keyHash;
  }
}
const byKey = new Map();
for (const [name, u] of Object.entries(users)) for (const h of u.keyHashes ?? []) byKey.set(h, name);
const cache = new Map(); // name -> { events: [], ids: Set }

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

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

function eventsOf(name) {
  if (!cache.has(name)) {
    const file = join(DATA, "events", `${name}.jsonl`);
    const events = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    cache.set(name, { events, ids: new Set(events.map((e) => e.id)) });
  }
  return cache.get(name);
}

// ---------- events ----------

const NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const clean = (s, max) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, "").slice(0, max) : "");
const count = (n, max) => (Number.isInteger(n) && n >= 0 ? Math.min(n, max) : 0);

/** Checks one event from a client. Returns the stored form or null. */
function accept(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind;
  if (!["prompt", "tool", "stop", "interrupt"].includes(kind)) return null;
  const t = typeof raw.t === "string" ? Date.parse(raw.t) : NaN;
  const id = clean(raw.id, 64);
  const session = clean(raw.session, 100);
  if (Number.isNaN(t) || !id || !session) return null;

  const e = {
    id,
    session,
    project: clean(raw.project, 100) || "unknown",
    via: clean(raw.via, 30) || "claude-code",
    kind,
    t: new Date(t).toISOString(),
    got: new Date(now).toISOString(),
    late: Math.abs(now - t) > LATE_SECS * 1000,
  };
  if (kind === "prompt") {
    e.words = count(raw.words, 100000);
    e.chars = count(raw.chars, 1000000);
    e.images = count(raw.images, 100);
    e.specific = count(raw.specific, 100000);
    e.observation = raw.observation === true;
    e.generic = raw.generic === true;
    e.repeat = raw.repeat === true;
  }
  if (kind === "tool") e.tool = clean(raw.tool, 80);
  return e;
}

/** Turns stored events into the sessions shape web/steer.js works with. Late events are left out. */
function sessionsOf(name) {
  const bySession = new Map();
  for (const e of eventsOf(name).events) {
    if (e.late) continue;
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
  }
  const sessions = [...bySession.values()];
  for (const s of sessions) s.events.sort((a, b) => a.t - b.t);
  return sessions;
}

const reportOf = (name) => buildReport(sessionsOf(name), { days: null });

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
  "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'";

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(res, title, body, { refresh } = {}) {
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
  send(res, 200, html, "text/html; charset=utf-8", { "content-security-policy": PAGE_CSP });
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too big"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return null;
  }
}

function userFromKey(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  return m ? byKey.get(sha256(m[1])) ?? null : null;
}

function lateCount(name) {
  return eventsOf(name).events.filter((e) => e.late).length;
}

function profilePage(res, name) {
  const projects = reportOf(name);
  const late = lateCount(name);
  const last = eventsOf(name).events.at(-1);
  const hc = users[name].hc;
  const linked = hc
    ? `Linked to a Hack Club account${hc.verification_status === "verified" ? " (verified)" : ""}.`
    : "Not linked to a Hack Club account.";
  let body = `<h1>steer · ${esc(name)}</h1>
<p class="muted">Live. This page reloads every 30 seconds. ${last ? `Last activity ${esc(new Date(last.got).toUTCString())}.` : "Nothing tracked yet."} ${linked}</p>
`;
  if (projects.length) {
    body += renderReport(projects, {
      window: "all time",
      source: "events the steer client sent while working",
      sessions: false,
      projectLink: (p) => `/u/${encodeURIComponent(name)}/${encodeURIComponent(p)}`,
    });
  }
  if (late) {
    const what = late === 1 ? "1 event arrived more than 5 minutes after it happened and isn't" : `${late} events arrived more than 5 minutes after they happened and aren't`;
    body += `<p class="muted">${what} counted.</p>\n`;
  }
  page(res, `steer · ${name}`, body, { refresh: 30 });
}

function projectPage(res, name, project) {
  const p = reportOf(name).find((x) => x.name === project);
  if (!p) return send(res, 404, "No such project");
  const tools = [...new Set(eventsOf(name).events.filter((e) => e.project === project).map((e) => e.via ?? "claude-code"))];
  const body = `<h1><a href="/u/${encodeURIComponent(name)}">${esc(name)}</a> / ${esc(project)}</h1>
<p class="muted">Tracked from ${esc(tools.join(", "))}.</p>
${renderReport([p], { window: "all time", source: "events the steer client sent while working" })}`;
  page(res, `${project} · steer`, body);
}

function hoursJson(res, name, project) {
  const projects = reportOf(name).filter((p) => !project || p.name === project);
  if (project && !projects.length) return json(res, 404, { error: "no such project" });
  const hc = users[name].hc;
  json(res, 200, {
    user: name,
    // So programs can match hours to the person who submitted. Null if not linked.
    hackclub: hc ? { slack_id: hc.slack_id, verification_status: hc.verification_status, ysws_eligible: hc.ysws_eligible } : null,
    projects: projects.map((p) => ({
      name: p.name,
      sessions: p.sessions.length,
      your_secs: projectHuman(p),
      agent_secs: projectAgent(p),
      your_time: fmtDur(projectHuman(p)),
    })),
  });
}

// ---------- sign in with Hack Club ----------

const LOGIN_TTL = 10 * 60 * 1000;
const logins = new Map(); // login code -> { userCode, created, link, state, result }
const byState = new Map(); // oauth state -> login code

function sweepLogins() {
  const now = Date.now();
  for (const [code, l] of logins) {
    if (now - l.created > LOGIN_TTL) {
      logins.delete(code);
      if (l.state) byState.delete(l.state);
    }
  }
}

function loginPage(res, code) {
  const l = logins.get(code);
  if (!l) return page(res, "steer login", `<h1>steer</h1>\n<p>This login link expired. Run <code>steer login</code> again.</p>`);
  page(
    res,
    "steer login",
    `<h1>Sign in to steer</h1>
<p>Check that this code matches the one in your terminal:</p>
<p class="code">${esc(l.userCode)}</p>
<p><a class="button" href="/login/go?code=${encodeURIComponent(code)}">Continue with Hack Club</a></p>
<p class="muted">Only continue if you just ran steer login on your own computer. That terminal gets signed in as you.</p>`,
  );
}

function loginRedirect(res, code) {
  const l = logins.get(code);
  if (!l || !HCA) return loginPage(res, code);
  l.state = randomBytes(16).toString("base64url");
  byState.set(l.state, code);
  const q = new URLSearchParams({
    client_id: HCA.id,
    redirect_uri: `${PUBLIC_URL}/auth/callback`,
    response_type: "code",
    scope: HCA_SCOPES,
    state: l.state,
  });
  res.writeHead(302, { location: `${HCA_BASE}/oauth/authorize?${q}` });
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
  for (let i = 2; users[name]; i++) name = `${base}-${i}`;
  return name;
}

async function authCallback(res, authCode, state) {
  const code = byState.get(state);
  const l = code && logins.get(code);
  if (!l || !HCA || !authCode) {
    return page(res, "steer login", `<h1>steer</h1>\n<p>This login didn't work or expired. Run <code>steer login</code> again.</p>`);
  }
  byState.delete(state);
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
  if (!name && l.link && users[l.link] && !users[l.link].hc) name = l.link;
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

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  let m;

  if (req.method === "GET" && STATIC[path]) {
    const [file, type] = STATIC[path];
    return send(res, 200, readFileSync(join(WEB, file)), type);
  }

  if (req.method === "POST" && path === "/api/signup") {
    if (HCA) return json(res, 410, { error: "this server uses hack club accounts, run steer login instead" });
    const body = await readJson(req);
    const name = typeof body?.name === "string" ? body.name.toLowerCase() : "";
    if (!NAME.test(name)) return json(res, 400, { error: "names are 2-32 letters, numbers, - or _" });
    if (users[name]) return json(res, 409, { error: "that name is taken" });
    users[name] = { keyHashes: [], created: new Date().toISOString() };
    return json(res, 201, { name, key: addKey(name) });
  }

  // ----- sign in with Hack Club -----
  // The terminal asks for a login code, opens /login?code=..., and polls until the
  // browser side is done. The short user code is shown in both places so someone
  // can't trick you into signing in their terminal as you.
  if (req.method === "POST" && path === "/api/cli-login") {
    if (!HCA) return json(res, 503, { error: "this server doesn't have hack club login set up, use steer signup" });
    sweepLogins();
    const code = randomBytes(16).toString("base64url");
    const hex = randomBytes(4).toString("hex").toUpperCase();
    const userCode = `${hex.slice(0, 4)}-${hex.slice(4)}`;
    logins.set(code, { userCode, created: Date.now(), link: userFromKey(req), result: null });
    return json(res, 200, { code, user_code: userCode, url: `${PUBLIC_URL}/login?code=${code}` });
  }
  if (req.method === "GET" && (m = /^\/api\/cli-login\/([A-Za-z0-9_-]+)$/.exec(path))) {
    const l = logins.get(m[1]);
    if (!l) return json(res, 404, { status: "expired" });
    if (!l.result) return json(res, 200, { status: "pending" });
    logins.delete(m[1]);
    return json(res, 200, { status: "done", ...l.result });
  }
  if (req.method === "GET" && path === "/login") return loginPage(res, url.searchParams.get("code") ?? "");
  if (req.method === "GET" && path === "/login/go") return loginRedirect(res, url.searchParams.get("code") ?? "");
  if (req.method === "GET" && path === "/auth/callback") {
    return authCallback(res, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
  }

  if (req.method === "POST" && path === "/api/events") {
    const name = userFromKey(req);
    if (!name) return json(res, 401, { error: "bad key" });
    const body = await readJson(req);
    if (!Array.isArray(body?.events) || body.events.length > 1000) return json(res, 400, { error: "send {events: [...]}" });
    const now = Date.now();
    const store = eventsOf(name);
    const fresh = [];
    for (const raw of body.events) {
      const e = accept(raw, now);
      if (!e || store.ids.has(e.id)) continue;
      store.ids.add(e.id);
      store.events.push(e);
      fresh.push(e);
    }
    if (fresh.length) appendFileSync(join(DATA, "events", `${name}.jsonl`), fresh.map((e) => JSON.stringify(e) + "\n").join(""));
    return json(res, 200, { accepted: fresh.length, late: fresh.filter((e) => e.late).length });
  }

  if (req.method === "GET" && (m = /^\/u\/([^/]+)\/?$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    return users[name] ? profilePage(res, name) : send(res, 404, "No such user");
  }
  if (req.method === "GET" && (m = /^\/u\/([^/]+)\/([^/]+)\/?$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    return users[name] ? projectPage(res, name, decodeURIComponent(m[2])) : send(res, 404, "No such user");
  }
  if (req.method === "GET" && (m = /^\/api\/u\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    if (!users[name]) return json(res, 404, { error: "no such user" });
    return hoursJson(res, name, m[2] ? decodeURIComponent(m[2]) : null);
  }

  send(res, 404, "Not found");
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, "Something broke");
  });
}).listen(PORT, () => console.log(`steer server on :${PORT}, data in ${DATA}`));
