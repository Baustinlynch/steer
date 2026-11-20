// Tests "sign in with Hack Club" against a fake Hack Club Auth, end to end:
//   node tests/login.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_PORT = 18971;
const STEER_PORT = 18972;
const STEER = `http://127.0.0.1:${STEER_PORT}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Who the fake Hack Club says is logging in next.
let nextUser = {};
const fake = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "authcode");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
  } else if (url.pathname === "/oauth/token" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "tok" }));
  } else if (url.pathname === "/oauth/userinfo" && req.headers.authorization === "Bearer tok") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(nextUser));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => fake.listen(FAKE_PORT, ok));

// An existing name-only account in the old one-key format.
const data = mkdtempSync(join(tmpdir(), "steer-login-"));
mkdirSync(join(data, "events"));
writeFileSync(join(data, "users.json"), JSON.stringify({ duck: { keyHash: sha256("oldkey"), created: "2026-11-19T00:00:00Z" } }));

const server = spawn("node", ["server/server.mjs"], {
  env: {
    ...process.env,
    PORT: String(STEER_PORT),
    STEER_DATA: data,
    PUBLIC_URL: STEER,
    HCA_CLIENT_ID: "test-client",
    HCA_CLIENT_SECRET: "test-secret",
    HCA_BASE: `http://127.0.0.1:${FAKE_PORT}`,
  },
  stdio: "ignore",
});
for (let i = 0; i < 50; i++) {
  try {
    await fetch(STEER + "/");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const json = async (path, opts = {}) => {
  const res = await fetch(STEER + path, opts);
  return { status: res.status, body: await res.json() };
};

/** Runs one whole login like `steer login` and the browser would. */
async function login(key) {
  const start = await json("/api/cli-login", { method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {} });
  assert.equal(start.status, 200);
  const page = await (await fetch(start.body.url)).text();
  assert.ok(page.includes(start.body.user_code), "login page shows the same code as the terminal");
  assert.equal((await json(`/api/cli-login/${start.body.code}`)).body.status, "pending");

  const go = await fetch(`${STEER}/login/go?code=${start.body.code}`, { redirect: "manual" });
  const authorize = new URL(go.headers.get("location"));
  assert.equal(authorize.searchParams.get("client_id"), "test-client");
  assert.equal(authorize.searchParams.get("scope"), "openid profile slack_id verification_status");
  const back = await fetch(authorize, { redirect: "manual" });
  const done = await (await fetch(back.headers.get("location"))).text();
  assert.ok(done.includes("Signed in as"), done);

  const result = (await json(`/api/cli-login/${start.body.code}`)).body;
  assert.equal(result.status, "done");
  assert.equal((await json(`/api/cli-login/${start.body.code}`)).status, 404, "the key is only handed out once");
  return result;
}

try {
  // 1. Existing account: logging in with its key links it instead of making a new one.
  nextUser = { sub: "ident!aaa", nickname: "Duck", slack_id: "U123", verification_status: "verified", ysws_eligible: true };
  const linked = await login("oldkey");
  assert.equal(linked.name, "duck");
  const events = (key) => json("/api/events", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: '{"events":[]}' });
  assert.equal((await events(linked.key)).status, 200, "new key works");
  assert.equal((await events("oldkey")).status, 200, "old key still works");
  const api = (await json("/api/u/duck")).body;
  assert.deepEqual(api.hackclub, { slack_id: "U123", verification_status: "verified", ysws_eligible: true });

  // 2. Same Hack Club account on another computer (no key): same account.
  assert.equal((await login(null)).name, "duck");

  // 3. Someone new gets a name from their nickname.
  nextUser = { sub: "ident!bbb", nickname: "Orpheus the Dino", slack_id: "U456", verification_status: "pending", ysws_eligible: false };
  assert.equal((await login(null)).name, "orpheus-the-dino");

  // 4. A different Hack Clubber can't take over a linked account, even with its key.
  nextUser = { sub: "ident!ccc", nickname: "duck", slack_id: "U789" };
  const other = await login(linked.key);
  assert.notEqual(other.name, "duck");
  assert.equal(other.name, "duck-2");

  // 5. Name-only signup is off, and bad links fail politely.
  assert.equal((await json("/api/signup", { method: "POST", body: '{"name":"sneaky"}' })).status, 410);
  assert.ok((await (await fetch(`${STEER}/auth/callback?code=x&state=nope`)).text()).includes("didn't work or expired"));
  assert.ok((await (await fetch(`${STEER}/login?code=nope`)).text()).includes("expired"));
  assert.equal((await json("/api/cli-login/nope")).body.status, "expired");

  console.log("login tests passed");
} finally {
  server.kill();
  fake.close();
  rmSync(data, { recursive: true, force: true });
}
