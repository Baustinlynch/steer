// Runs inside chatgpt.com and claude.ai, in the page's own JavaScript. It notices when
// you send a chat message and when the answer is done, and tells steer's extension
// (the prompt's text is counted inside the extension's worker and goes nowhere else).
(() => {
  if (window.__steerWatching) return;
  window.__steerWatching = true;
  const host = location.hostname;
  const site = host === "chatgpt.com" || host.endsWith(".chatgpt.com") ? "chatgpt" : host === "claude.ai" || host.endsWith(".claude.ai") ? "claude-ai" : null;
  if (!site) return;
  // One session per open tab. It's made here because Chrome stops the extension's
  // worker between chats, and the worker would forget it.
  const session = `${site}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let previous = ""; // the last prompt, so the worker can spot the same one sent again
  const tell = (msg) => window.postMessage({ steer: 1, site, session, ...msg }, location.origin);

  // claude.ai sends messages in its own binary format, so the message is read from the
  // text box when you press enter or the send button, and counts once it's sent.
  const CLAUDE_BOX = '[data-testid="chat-input"]';
  const CLAUDE_SEND = '[data-testid="chat-input-send"], button[aria-label="Send message"]';
  const CLAUDE_SENT = /^\/claudeai-rpc\/[\w.]*ConversationService\/PerformAction$/;
  let typed = null;
  if (site === "claude-ai") {
    const grab = () => {
      const box = document.querySelector(CLAUDE_BOX);
      const text = (box?.innerText ?? "").trim();
      if (!text) return;
      const area = box.closest("fieldset") ?? box.parentElement;
      const images = area ? area.querySelectorAll('img, [data-testid*="thumbnail" i]').length : 0;
      typed = { text, images, at: Date.now() };
    };
    document.addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target?.closest?.(CLAUDE_BOX) && grab(), true);
    document.addEventListener("click", (e) => e.target?.closest?.(CLAUDE_SEND) && grab(), true);
  }

  // Whether this chat is what the person is looking at: the tab showing and its window in
  // front. Sent each time that changes, so reading counts whether or not they scroll. The
  // idle timer in the steer app says whether anyone's at the computer at all. A change
  // that lasts under a second (alt-tabbing past it) isn't sent; one that does is stamped
  // with when it happened.
  let focused = null; // what was last sent
  let pending = null;
  const inFront = () => document.visibilityState === "visible" && document.hasFocus();
  const checkFocus = () => {
    const now = inFront();
    clearTimeout(pending);
    if (now === focused) return;
    const at = Date.now();
    pending = setTimeout(() => {
      if (inFront() !== now || now === focused) return;
      focused = now;
      tell({ type: "focus", on: now, at });
    }, 1000);
  };
  window.addEventListener("focus", checkFocus);
  window.addEventListener("blur", checkFocus);
  document.addEventListener("visibilitychange", checkFocus);
  window.addEventListener("pagehide", () => {
    clearTimeout(pending);
    if (focused) tell({ type: "focus", on: false, at: Date.now() });
    focused = false;
  });
  // Not at document_start: the extension's side isn't listening yet.
  document.addEventListener("DOMContentLoaded", checkFocus);

  // Copying out of the chat, at most every 5 seconds.
  let copied = 0;
  document.addEventListener(
    "copy",
    () => {
      if (Date.now() - copied < 5000 || !inFront()) return;
      copied = Date.now();
      tell({ type: "copy" });
    },
    true,
  );

  // The first key typed in the message box since the last message went out: when
  // writing the next prompt started.
  let composing = false;
  document.addEventListener(
    "keydown",
    (e) => {
      if (composing || e.key?.length !== 1 || e.ctrlKey || e.metaKey) return;
      if (!e.target?.closest?.('[contenteditable="true"], textarea')) return;
      composing = true;
      tell({ type: "typing" });
    },
    true,
  );

  /** What a request to the site's own server says about a sent message, or null. */
  function sentMessage(url, method, body) {
    if (site === "chatgpt") {
      if (method !== "POST" || !/\/backend-api\/(f\/)?conversation\/?$/.test(url.pathname)) return null;
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {}
      if (!Array.isArray(json?.messages)) return null;
      const user = json.messages.filter((m) => m?.author?.role === "user").pop();
      if (!user) return null;
      const parts = Array.isArray(user.content?.parts) ? user.content.parts : [];
      const text = parts.filter((p) => typeof p === "string").join("\n");
      const images = parts.filter((p) => p && typeof p === "object" && String(p.content_type ?? "").includes("image")).length;
      return { text, images };
    }
    if (method === "POST" && CLAUDE_SENT.test(url.pathname) && typed && Date.now() - typed.at < 5000) {
      const sent = typed;
      typed = null;
      return sent;
    }
    // How claude.ai sent messages before, in case some accounts still do.
    if (method === "POST" && /\/chat_conversations\/[^/]+\/completion\/?$/.test(url.pathname)) {
      try {
        const json = JSON.parse(body);
        if (typeof json?.prompt === "string") return { text: json.prompt, images: Array.isArray(json.files) ? json.files.length : 0 };
      } catch {}
    }
    return null;
  }

  /** True while the page shows a button to stop the answer, so it's still writing.
   * ChatGPT keeps a hidden one around after the answer, so only a visible one counts. */
  const writing = () =>
    [...document.querySelectorAll('[data-testid="stop-button"], [data-testid="chat-input-stop"], button[aria-label*="Stop" i]')].some((b) => b.getClientRects().length > 0);

  /** Tells the worker once the answer is done: the request has ended and the page's stop
   * button is gone. Checks whenever the page changes, since timers barely run in a
   * background tab, and every half second too. */
  function whenDone(response, id) {
    let ended = false;
    let seen = false;
    let done = false;
    const started = Date.now();
    const finish = () => {
      done = true;
      observer?.disconnect();
      tell({ type: "stop", id });
    };
    const check = () => {
      if (done) return;
      if (writing()) seen = true;
      // Some answers stream over another connection, so the stop button is the sign.
      const quiet = !writing() && (seen || Date.now() - started > 3000);
      if ((ended && quiet) || Date.now() - started > 30 * 60 * 1000) finish();
    };
    const observer = typeof MutationObserver === "function" && document.documentElement ? new MutationObserver(check) : null;
    observer?.observe(document.documentElement, { childList: true, subtree: true });
    const reader = response?.clone().body?.getReader();
    const end = () => {
      ended = true;
      check();
    };
    const pump = () => reader.read().then(({ done }) => (done ? end() : pump()), end);
    if (reader) pump();
    else ended = true;
    const tick = () => {
      check();
      if (!done) setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  }

  const original = window.fetch;
  window.fetch = function (input, init) {
    const result = original.apply(this, arguments);
    try {
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (method !== "GET" && url.origin === location.origin) {
        const sent = sentMessage(url, method, typeof init?.body === "string" ? init.body : null);
        if (sent) {
          const id = Math.random().toString(36).slice(2);
          tell({ type: "prompt", id, text: sent.text, images: sent.images, previous });
          previous = sent.text;
          composing = false;
          result.then(
            (response) => whenDone(response, id),
            () => tell({ type: "stop", id }),
          );
        }
      }
    } catch {}
    return result;
  };
})();
