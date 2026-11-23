// Counts each prompt here, with the same code steer's website uses, and hands only the
// counts to the steer app on this computer (native messaging). The app knows the
// account and the project and sends them with everything else. No prompt text leaves
// the browser.
import { analyzePrompt } from "./steer.js";

const HOST = "app.steer.native";
let lastError = null;
let lastSent = null;

function toApp(message) {
  chrome.runtime.sendNativeMessage(HOST, message, () => {
    if (chrome.runtime.lastError) lastError = chrome.runtime.lastError.message;
    else {
      lastError = null;
      lastSent = Date.now();
    }
  });
}

/** Share of words two prompts have in common, like the app's repeat check. */
function overlap(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (m.type === "status") {
    reply({ lastError, lastSent });
    return;
  }
  if (sender.tab?.id == null || (m.site !== "chatgpt" && m.site !== "claude-ai")) return;
  // page.js makes the session, one per open tab. Chrome stops this worker between
  // chats, so it can't keep track of that itself.
  const session = /^[a-z0-9-]{4,60}$/.test(m.session ?? "") ? m.session : `${m.site}-tab-${sender.tab.id}`;
  if (m.type === "prompt") {
    const p = analyzePrompt(m.text, m.images);
    const repeat = p.words >= 3 && !!m.previous && overlap(p.wordSet, analyzePrompt(m.previous, 0).wordSet) >= 0.6;
    toApp({
      kind: "prompt",
      via: m.site,
      session,
      words: p.words,
      chars: p.chars,
      images: p.images,
      specific: p.specific,
      observation: p.observation,
      generic: p.generic,
      repeat,
    });
  } else if (m.type === "stop") {
    toApp({ kind: "stop", via: m.site, session });
  }
});
