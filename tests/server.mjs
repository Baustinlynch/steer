// Tests the server's limits and checks: rate limits, the daily cap, request sizes,
// which events get refused, odd paths and cached pages.
//   node tests/server.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18973;
const STEER = `http://127.0.0.1:${PORT}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

// Close to midnight UTC the daily count could reset halfway through, so wait it out.
const toMidnight = 86_400_000 - (Date.now() % 86_400_000);
if (toMidnight < 120_000) await sleep(toMidnight + 1000);

const data = mkdtempSync(join(tmpdir(), "steer-server-"));
mkdirSync(join(data, "events"));
const users = {
  big: { keyHashes: [sha256("big-key")], created: "2026-11-01T00:00:00Z" },
  capped: { keyHashes: [sha256("capped-key")], created: "2026-11-01T00:00:00Z" },
};
writeFileSync(join(data, "users.json"), JSON.stringify(users));

// big: 1,200 sessions of 100 events in 3 projects, so its pages take a while to work out.
const lines = [];
const start = Date.parse("2026-10-01T00:00:00Z");
for (let s = 0; s < 1200; s++) {
  let t = start + s * 3_600_000;
  for (let i = 0; i < 100; i++) {
    t += 20_000;
    const kind = i % 5 === 0 ? "prompt" : i % 5 === 4 ? "stop" : "tool";
    const e = { id: `e${s}-${i}`, session: `s${s}`, project: `p${s % 3}`, via: "claude-code", kind, t: iso(t), got: iso(t), late: false };
    if (kind === "prompt") Object.assign(e, { words: 30, chars: 160, images: 0, specific: 2, observation: false, generic: false, repeat: false });
    if (kind === "tool") e.tool = "Edit";
    lines.push(JSON.stringify(e));
  }
}
writeFileSync(join(data, "events", "big.jsonl"), lines.join("\n") + "\n");

// capped: already sent 19,900 events today.
const now = iso(Date.now());
const today = Array.from({ length: 19_900 }, (_, i) =>
  JSON.stringify({ id: `c${i}`, session: "s", project: "x", via: "claude-code", kind: "stop", t: now, got: now, late: true }),
);
writeFileSync(join(data, "events", "capped.jsonl"), today.join("\n") + "\n");

const server = spawn("node", ["server/server.mjs"], {
  env: { ...process.env, PORT: String(PORT), STEER_DATA: data, PUBLIC_URL: STEER },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 50; i++) {
  try {
    await fetch(STEER + "/");
    break;
  } catch {
    await sleep(100);
  }
}

// Every request comes from 127.0.0.1, so X-Forwarded-For is believed, like behind the proxy.
const signup = async (name, ip = "10.0.0.1") => {
  const res = await fetch(STEER + "/api/signup", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify({ name }) });
  return { status: res.status, body: await res.json() };
};
const post = async (key, body) => {
  const res = await fetch(STEER + "/api/events", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, retry: res.headers.get("retry-after"), body: await res.json().catch(() => null) };
};
let n = 0;
const ev = (o = {}) => ({ id: `id-${n++}`, session: "sess", project: "game", via: "claude-code", kind: "tool", tool: "Edit", t: iso(Date.now()), ...o });
const prompt = (o = {}) =>
  ev({ kind: "prompt", tool: undefined, words: 12, chars: 60, images: 0, specific: 1, observation: false, generic: false, repeat: false, ...o });
/**
 * Posts 1.2 MB. With `declared` the size is in Content-Length and nothing more is sent
 * until the server answers; without it the body streams until the server hangs up.
 * Returns the status, or the error code if the connection was cut.
 */
const bigPost = (key, declared) =>
  new Promise((done) => {
    const headers = { authorization: `Bearer ${key}`, ...(declared ? { "content-length": "1200000" } : {}) };
    const req = request(`${STEER}/api/events`, { method: "POST", headers }, (res) => {
      res.resume();
      req.destroy();
      done(res.statusCode);
    });
    req.on("error", (err) => done(err.code));
    if (declared) req.flushHeaders();
    else for (let i = 0; i < 12; i++) req.write("x".repeat(100_000));
  });
const get = async (path) => {
  const a = Date.now();
  const res = await fetch(STEER + path);
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - a };
};

try {
  const alice = (await signup("alice")).body.key;
  assert.ok(alice);

  // 1. Request size and batch size.
  assert.equal(await bigPost(alice, true), 413, "a body that says it's over 1 MB is refused before it's sent");
  assert.ok(["413", "EPIPE", "ECONNRESET"].includes(String(await bigPost(alice, false))), "one that turns out over 1 MB gets cut off");
  assert.equal((await post(alice, { events: Array.from({ length: 501 }, () => ev()) })).status, 413, "more than 500 events at once is refused");
  assert.equal((await post(alice, { nope: 1 })).status, 400);
  const full = await post(alice, { events: Array.from({ length: 500 }, () => ev()) });
  assert.equal(full.status, 200);
  assert.equal(full.body.accepted, 500, "500 at once is fine, that's what the client sends");

  // 2. Which events get refused.
  const long = "x".repeat(300);
  const bad = [
    prompt({ words: "5" }),
    prompt({ chars: -1 }),
    prompt({ images: 1000 }),
    prompt({ words: 1.5 }),
    prompt({ words: 50, chars: 10 }),
    prompt({ specific: 40, words: 10 }),
    prompt({ observation: "yes" }),
    ev({ id: 123 }),
    ev({ id: long }),
    ev({ session: long }),
    ev({ project: long }),
    ev({ tool: long }),
    ev({ session: ["s"] }),
    ev({ via: "vim" }),
    ev({ via: "" }),
    ev({ kind: "hack" }),
    ev({ kind: "interrupt", via: "claude-code" }),
    ev({ kind: "interrupt", via: "cursor" }),
    ev({ kind: "interrupt", via: "opencode" }),
    ev({ kind: "interrupt", via: undefined }),
    ev({ t: "1" }),
    ev({ t: 1763600000000 }),
    ev({ t: undefined }),
    null,
    [],
    "event",
  ];
  const good = [
    ev({ kind: "interrupt", via: "codex" }),
    ev({ kind: "interrupt", via: "copilot" }),
    ev({ t: iso(Date.now() + 20_000) }),
    ev({ t: iso(Date.now() - 10 * 60_000) }),
    prompt({ via: "cursor" }),
    prompt({ words: 0, chars: 0, images: 2, specific: 0, via: "opencode" }),
    // Copilot ids are longer than 64, they're cut like before.
    ev({ id: `cp-${"a".repeat(36)}-${"b".repeat(36)}`, via: "copilot" }),
    // Clients from before Codex support don't send via.
    ev({ via: undefined }),
    // From the future: kept, but late, so a wrong clock shows up instead of vanishing.
    ev({ t: iso(Date.now() + 60_000) }),
    ev({ t: iso(Date.now() + 3_600_000) }),
  ];
  const mixed = await post(alice, { events: [...bad, ...good] });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.body, { accepted: good.length, late: 3, dropped: bad.length });
  const stored = readFileSync(join(data, "events", "alice.jsonl"), "utf8").trim().split("\n").slice(500).map((l) => JSON.parse(l));
  assert.equal(stored.length, good.length, "nothing refused got stored");
  assert.equal(stored[6].id, good[6].id.slice(0, 64));
  assert.equal(stored[7].via, "claude-code");
  assert.equal(stored[2].late, false, "20 s ahead is clock drift, it still counts");
  assert.equal(stored[3].late, true, "10 minutes old arrives late");
  assert.equal(stored[8].late, true, "a minute ahead doesn't count");
  assert.equal(stored[9].late, true, "an hour ahead doesn't count");
  assert.equal((await post(alice, { events: good })).body.accepted, 0, "repeats are skipped");

  // 3. Rate limit per key: 5,000 at once, then 2 a second.
  const bob = (await signup("bob", "10.0.0.2")).body.key;
  for (let i = 0; i < 10; i++) assert.equal((await post(bob, { events: Array.from({ length: 500 }, () => ev()) })).status, 200);
  const limited = await post(bob, { events: Array.from({ length: 500 }, () => ev()) });
  assert.equal(limited.status, 429, "a key that sent 5,000 events in a few seconds has to wait");
  assert.ok(Number(limited.retry) > 0, "and is told how long");
  assert.equal((await post(alice, { events: [ev()] })).status, 200, "other keys aren't slowed down");

  // 4. At most 20,000 events per account per day.
  const capped = await post("capped-key", { events: Array.from({ length: 200 }, () => ev()) });
  assert.equal(capped.status, 429);
  assert.match(capped.body.error, /today/);
  assert.ok(Number(capped.retry) > 0 && Number(capped.retry) <= 86_400);
  assert.equal((await post("capped-key", { events: Array.from({ length: 100 }, () => ev()) })).body.accepted, 100, "up to the cap is fine");
  assert.equal((await post("capped-key", { events: [ev()] })).status, 429, "one more isn't");
  assert.equal((await post("capped-key", { events: [] })).status, 200, "checking the key still works");

  // 5. Per-IP signup limit.
  for (let i = 0; i < 10; i++) assert.equal((await signup(`many-${i}`, "10.0.0.9")).status, 201);
  assert.equal((await signup("many-10", "10.0.0.9")).status, 429);
  assert.equal((await signup("someone", "10.0.0.10")).status, 201, "other addresses can still sign up");

  // 6. Names that are Object properties, and broken % escapes.
  for (const path of ["/u/__proto__", "/u/constructor", "/u/toString", "/u/hasOwnProperty/x", "/u/__proto__/x"]) {
    assert.equal((await get(path)).status, 404, path);
  }
  for (const path of ["/api/u/toString", "/api/u/__proto__", "/api/u/constructor/x"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(JSON.parse(res.text), { error: "no such user" });
  }
  for (const path of ["/u/%E0%A4%A", "/u/alice/%E0", "/api/u/%zz", "/api/u/alice/%E0", "/u/%"]) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.ok(!res.text.includes("URIError") && !res.text.includes(" at "), "no stack trace");
  }
  assert.equal((await signup("constructor", "10.0.0.11")).status, 201, "constructor is a normal name");
  assert.equal((await get("/u/constructor")).status, 200);

  // 7. Pages are cached, and working one out doesn't hold up events.
  const first = get("/u/big");
  await sleep(20);
  const a = Date.now();
  assert.equal((await post(alice, { events: [ev()] })).status, 200);
  const during = Date.now() - a;
  const cold = await first;
  assert.equal(cold.status, 200);
  assert.ok(during < 500, `events still go in while a big page is worked out (${during} ms)`);
  const warm = await get("/u/big");
  assert.equal(warm.text, cold.text);
  assert.ok(warm.ms < 150 && warm.ms < cold.ms / 2, `second view is cached (${cold.ms} ms, then ${warm.ms} ms)`);
  const api = await get("/api/u/big");
  assert.ok(api.ms < 150, `the api uses the same cache (${api.ms} ms)`);
  assert.equal(JSON.parse(api.text).projects.reduce((n, p) => n + p.sessions, 0), 1200);
  const views = await Promise.all(Array.from({ length: 10 }, () => get("/u/big")));
  assert.ok(views.every((v) => v.status === 200 && v.ms < 500), "10 views at once are fine");

  // 8. A project page draws only the newest sessions.
  const project = await get("/u/big/p0");
  assert.equal(project.status, 200);
  assert.match(project.text, /Showing the newest 100 of 400 sessions/);
  assert.equal(project.text.match(/<details>/g).length, 100);
  assert.equal((await get("/u/big/nope")).status, 404);

  console.log(`server tests passed (big page ${cold.ms} ms, then ${warm.ms} ms cached)`);
} finally {
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
