// Runs the browser extension's scripts against a fake ChatGPT and Claude page and
// checks what reaches the steer app: counts when a prompt is sent and a stop when the
// answer is done, never the prompt text. The fakes copy what the real sites did in
// November 2026: ChatGPT posts JSON to /backend-api/f/conversation and streams the
// answer back, claude.ai sends a binary request to ConversationService/PerformAction
// and streams the answer over a connection that stays open.
//   node tests/extension.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../extension/${f}`, import.meta.url), "utf8");
assert.equal(read("steer.js"), readFileSync(new URL("../web/steer.js", import.meta.url), "utf8"), "extension/steer.js is a copy of web/steer.js: cp web/steer.js extension/steer.js");
const manifest = JSON.parse(read("manifest.json"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["nativeMessaging"], "the extension asks for nothing else");
assert.equal(manifest.host_permissions, undefined);
// The store's copy and the one loaded from this folder (its id comes from the key).
assert.ok(readFileSync(new URL("../src/native.rs", import.meta.url), "utf8").includes('EXTENSION_IDS: [&str; 2] = ["hbdpmjejoniaeejpnobbhpfbphppokgp", "badjomjdmajniieefpgbnglnocamhmck"]'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_BOX = '[data-testid="chat-input"]';

/** A fake page at `origin`: page.js and bridge.js run in it, and what the bridge would
 * hand the extension's worker lands in `toWorker`. */
function fakePage(origin, serve) {
  const toWorker = [];
  let stopButton = false;
  const box = { innerText: "", images: 0 };
  const area = { querySelectorAll: () => ({ length: box.images }) };
  box.closest = () => area;
  const windowListeners = {};
  const documentListeners = {};
  const window = {
    location: new URL(origin),
    fetch: async (input, init) => serve(input, init),
    postMessage(data, target) {
      assert.equal(target, origin);
      for (const l of windowListeners.message ?? []) l({ source: window, origin, data });
    },
    addEventListener: (type, fn) => (windowListeners[type] ??= []).push(fn),
  };
  // ChatGPT leaves a hidden stop button in the page after the answer, which doesn't count.
  const hiddenStop = { getClientRects: () => [] };
  const shownStop = { getClientRects: () => [{}] };
  const document = {
    documentElement: {},
    visibilityState: "visible",
    focused: true,
    hasFocus() {
      return this.focused;
    },
    addEventListener: (type, fn) => (documentListeners[type] ??= []).push(fn),
    querySelector: (sel) => (sel === CLAUDE_BOX ? box : null),
    querySelectorAll: (sel) => (sel.includes("stop") ? (stopButton ? [hiddenStop, shownStop] : [hiddenStop]) : []),
  };
  const chrome = { runtime: { sendMessage: (m) => (toWorker.push(m), Promise.resolve()) } };
  const ctx = vm.createContext({ window, document, chrome, location: window.location, URL, Request, setTimeout, clearTimeout, Date, Math, JSON, String, Number, Array, Promise });
  vm.runInContext(read("page.js"), ctx);
  vm.runInContext(read("bridge.js"), ctx);
  const inBox = { closest: (sel) => (sel === CLAUDE_BOX ? box : null) };
  return {
    window,
    toWorker,
    types: () => toWorker.map((m) => m.type),
    setWriting: (on) => (stopButton = on),
    type: (text, images = 0) => Object.assign(box, { innerText: text, images }),
    pressEnter: (shiftKey = false) => documentListeners.keydown.forEach((fn) => fn({ key: "Enter", shiftKey, isComposing: false, target: inBox })),
    fire: (type, target = {}, key = "a") => (documentListeners[type] ?? []).forEach((fn) => fn({ key, target })),
    fireWindow: (type) => (windowListeners[type] ?? []).forEach((fn) => fn({})),
    document,
  };
}

/** A streamed answer that ends after `ms`. */
const streamed = (ms) =>
  new Response(
    new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode("data: {}\n\n"));
        await sleep(ms);
        c.close();
      },
    }),
  );

const chatgptBody = (text) =>
  JSON.stringify({
    action: "next",
    conversation_id: "c1",
    messages: [{ author: { role: "user" }, content: { content_type: "multimodal_text", parts: [text, { content_type: "image_asset_pointer" }] } }],
  });

// ChatGPT: the prompt's text reaches only the worker, then a stop once the answer ends.
{
  const page = fakePage("https://chatgpt.com", () => streamed(300));
  page.setWriting(true);
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", body: chatgptBody("the jump in player.rs is broken, it says NaN") });
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation/prepare", { method: "POST", body: "{}" });
  await page.window.fetch("https://chatgpt.com/backend-api/me", { method: "GET" });
  await page.window.fetch("https://chatgpt.com/backend-api/conversation/init", { method: "POST", body: '{"conversation_id":"c1"}' });
  assert.deepEqual(page.types(), ["prompt"], "only the sent message counts");
  assert.equal(page.toWorker[0].images, 1);
  assert.match(page.toWorker[0].text, /player\.rs/);
  assert.equal(page.toWorker[0].previous, "");
  await sleep(700);
  assert.deepEqual(page.types(), ["prompt"], "still writing");
  page.setWriting(false);
  await sleep(700);
  assert.deepEqual(page.types(), ["prompt", "stop"]);
  // The next message knows the last one, so the worker can spot a repeat, and it's
  // the same session.
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", body: chatgptBody("still NaN") });
  assert.match(page.toWorker[2].previous, /player\.rs/);
  assert.match(page.toWorker[0].session, /^chatgpt-[a-z0-9-]+$/);
  assert.ok(page.toWorker.every((m) => m.session === page.toWorker[0].session));
}

// ChatGPT without a stop button (as if the site renamed it): the stop comes 3s in.
{
  const page = fakePage("https://chatgpt.com", () => streamed(300));
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", body: chatgptBody("hi") });
  await sleep(1200);
  assert.deepEqual(page.types(), ["prompt"]);
  await sleep(2600);
  assert.deepEqual(page.types(), ["prompt", "stop"]);
}

// claude.ai: the message is read from the text box when it's sent. The answer goes on
// after the request ends, while the stop button shows.
{
  const page = fakePage("https://claude.ai", () => streamed(20));
  const rpc = "https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction";
  // Other actions (renaming a chat, starring it) go through the same request.
  await page.window.fetch(rpc, { method: "POST", body: new Uint8Array([1]) });
  // Shift+enter is a new line, not sending.
  page.type("fix the NaN in `player.rs` when landing", 1);
  page.pressEnter(true);
  await page.window.fetch(rpc, { method: "POST", body: new Uint8Array([2]) });
  assert.deepEqual(page.types(), []);
  page.pressEnter();
  page.setWriting(true);
  await page.window.fetch(rpc, { method: "POST", body: new Uint8Array([3]) });
  await page.window.fetch(rpc, { method: "POST", body: new Uint8Array([4]) });
  assert.deepEqual(page.types(), ["prompt"], "one message, one prompt");
  assert.match(page.toWorker[0].text, /player\.rs/);
  assert.equal(page.toWorker[0].images, 1);
  assert.match(page.toWorker[0].session, /^claude-ai-/);
  await sleep(1200);
  assert.deepEqual(page.types(), ["prompt"], "still writing");
  page.setWriting(false);
  await sleep(800);
  assert.deepEqual(page.types(), ["prompt", "stop"]);
  // Pressing enter and then nothing being sent (an empty box, a failed send) is nothing.
  page.type("");
  page.pressEnter();
  await page.window.fetch(rpc, { method: "POST", body: new Uint8Array([5]) });
  assert.equal(page.toWorker.length, 2);
}

// claude.ai the way it sent messages before, in case some accounts still do.
{
  const page = fakePage("https://claude.ai", () => streamed(50));
  await page.window.fetch("https://claude.ai/api/organizations/o/chat_conversations/c9/completion", {
    method: "POST",
    body: JSON.stringify({ prompt: "continue", files: [] }),
  });
  assert.deepEqual(page.types(), ["prompt"]);
  assert.equal(page.toWorker[0].text, "continue");
}

// Whether the chat is in front, sent each time that changes and lasts a second, stamped
// with when it changed.
{
  const page = fakePage("https://chatgpt.com", () => streamed(10));
  const step = async (change) => {
    change();
    await sleep(1100);
  };
  const loaded = Date.now();
  await step(() => page.fire("DOMContentLoaded")); // loaded in front
  await step(() => {
    page.document.focused = false; // another app came to the front
    page.fireWindow("blur");
  });
  // Alt-tabbing past it: back in front for a moment and gone again. Nothing sent.
  page.document.focused = true;
  page.fireWindow("focus");
  await sleep(200);
  page.document.focused = false;
  page.fireWindow("blur");
  await sleep(1100);
  await step(() => {
    page.document.focused = true;
    page.fireWindow("focus");
  });
  page.fireWindow("focus"); // nothing changed
  await step(() => {
    page.document.visibilityState = "hidden"; // another tab
    page.fire("visibilitychange");
  });
  page.document.visibilityState = "visible";
  page.fire("visibilitychange");
  page.fireWindow("pagehide"); // closed right away: sent at once
  assert.deepEqual(
    page.toWorker.map((m) => [m.type, m.on]),
    [
      ["focus", true],
      ["focus", false],
      ["focus", true],
      ["focus", false],
    ],
  );
  assert.ok(Math.abs(page.toWorker[0].at - loaded) < 100, "stamped when it changed, not a second later");
  assert.ok(page.toWorker.every((m) => m.session === page.toWorker[0].session && m.text === ""));
}

// Copying out of the chat, and when writing each message started.
{
  const page = fakePage("https://chatgpt.com", () => streamed(10));
  const box = { closest: (sel) => (sel.includes("textarea") ? {} : null) };
  page.fire("copy");
  page.fire("copy"); // within 5 seconds
  page.fire("keydown", box, "Enter"); // not a typed character
  page.fire("keydown", box, "t");
  page.fire("keydown", box, "h"); // still the same message
  page.fire("keydown", { closest: () => null }, "x"); // typing somewhere else on the page
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", body: chatgptBody("the jump is floaty") });
  page.fire("keydown", box, "n"); // the next message
  assert.deepEqual(page.types(), ["copy", "typing", "prompt", "typing"]);
  // A tab in the background doesn't count a copy.
  const hidden = fakePage("https://claude.ai", () => streamed(10));
  hidden.document.visibilityState = "hidden";
  hidden.fire("copy");
  assert.equal(hidden.toWorker.length, 0);
  // The page can't make up other kinds, or a focus that's neither on nor off.
  page.window.postMessage({ steer: 1, site: "chatgpt", type: "keys" }, "https://chatgpt.com");
  page.window.postMessage({ steer: 1, site: "chatgpt", type: "focus", on: "yes" }, "https://chatgpt.com");
  assert.equal(page.toWorker.length, 4);
}

// Other sites' messages don't get through the bridge.
{
  const page = fakePage("https://chatgpt.com", () => streamed(10));
  page.window.postMessage({ steer: 1, site: "evil", type: "prompt", text: "x" }, "https://chatgpt.com");
  page.window.postMessage({ steer: 1, site: "chatgpt", type: "delete-everything" }, "https://chatgpt.com");
  assert.equal(page.toWorker.length, 0);
}

// The worker counts the prompt and only sends counts to the steer app.
{
  const toApp = [];
  let onMessage;
  globalThis.chrome = {
    runtime: {
      id: "me",
      lastError: null,
      sendNativeMessage: (host, m, cb) => {
        assert.equal(host, "app.steer.native");
        toApp.push(m);
        cb?.({ ok: true });
      },
      onMessage: { addListener: (fn) => (onMessage = fn) },
    },
  };
  await import(new URL("../extension/worker.js", import.meta.url));
  const from = { id: "me", tab: { id: 7 } };
  const text = "the jump in `player.rs` is broken, it says NaN when I land";
  const session = "chatgpt-mx1-abc";
  onMessage({ type: "prompt", site: "chatgpt", session, text, images: 0, previous: "" }, from, () => {});
  onMessage({ type: "stop", site: "chatgpt", session }, from, () => {});
  onMessage({ type: "prompt", site: "chatgpt", session, text, images: 0, previous: text }, from, () => {});
  onMessage({ type: "prompt", site: "chatgpt", session: "../../x", text: "hi", images: 0 }, from, () => {});
  onMessage({ type: "prompt", site: "chatgpt", session, text: "secret" }, { id: "someone-else", tab: { id: 7 } }, () => {});
  assert.equal(toApp.length, 4, "messages from other extensions are ignored");
  onMessage({ type: "focus", site: "chatgpt", session, on: true, at: 1234 }, from, () => {});
  onMessage({ type: "copy", site: "chatgpt", session }, from, () => {});
  onMessage({ type: "typing", site: "chatgpt", session }, from, () => {});
  onMessage({ type: "focus", site: "chatgpt", session, on: 1 }, from, () => {});
  onMessage({ type: "keys", site: "chatgpt", session }, from, () => {});
  assert.deepEqual(toApp.slice(4), [
    { kind: "focus", via: "chatgpt", session, on: true, at: 1234 },
    { kind: "copy", via: "chatgpt", session },
    { kind: "typing", via: "chatgpt", session },
  ]);
  assert.equal(toApp[0].kind, "prompt");
  assert.equal(toApp[0].via, "chatgpt");
  assert.ok(toApp[0].words >= 10 && toApp[0].specific >= 1 && toApp[0].observation === true);
  assert.equal(toApp[0].repeat, false);
  assert.equal(toApp[1].kind, "stop");
  assert.equal(toApp[2].repeat, true, "the same prompt again is a repeat");
  assert.deepEqual([toApp[0].session, toApp[1].session, toApp[2].session], [session, session, session], "the page's session is kept");
  assert.equal(toApp[3].session, "chatgpt-tab-7", "a strange session falls back to the tab");
  for (const m of toApp) assert.ok(!JSON.stringify(m).includes("player"), "no prompt text goes to the app");
}

console.log("extension tests passed");
