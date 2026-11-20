// Reads Claude Code session logs and works out your time vs agent time.
// Same rules as src/claude.rs, src/prompt.rs and src/analyze.rs. Works in the
// browser and in Node. Nothing in here sends data anywhere.

// ---------- prompts (src/prompt.rs) ----------

const GENERIC = new Set([
  "continue", "go", "go on", "go ahead", "yes", "y", "yep", "yeah", "ok", "okay", "k",
  "do it", "fix it", "fix", "fix this", "keep going", "proceed", "try again", "again",
  "next", "sure", "lgtm", "looks good", "retry", "more", "same", "please", "pls",
]);

const OBSERVATION = [
  "when i", "it shows", "it says", "doesn't", "doesnt", "does not", "didn't", "didnt",
  "not working", "isn't", "isnt", "broken", "broke", "i clicked", "i tried", "i see",
  "i get", "i got", "instead of", "still", "now it", "works now", "it works", "crash",
  "error", "fails", "failed", "freez", "stuck", "wrong", "nothing happens", "blank",
  "undefined", "exception", "traceback", "warning", "bug", "glitch", "flicker", "lag",
];

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const KEEP = /[\p{Alphabetic}\p{N}_/.:()]/u;
const utf8 = new TextEncoder();
const words = (s) => s.split(/\s+/).filter(Boolean);

export function analyzePrompt(text, images) {
  const lower = text.toLowerCase();
  let normalized = "";
  for (const c of lower) normalized += ALNUM.test(c) || c === "'" ? c : " ";
  const normWords = words(normalized);
  const joined = normWords.join(" ");
  const raw = words(text);

  let specific = raw.filter(isSpecific).length;
  if (text.includes("`")) specific++;
  if (text.split("\n").filter((l) => l.trim() !== "").length > 3) specific++;
  const observation = images > 0 || OBSERVATION.some((p) => lower.includes(p));
  const generic =
    images === 0 && (GENERIC.has(joined) || (normWords.length <= 3 && specific === 0 && !observation));

  return {
    chars: [...text].length,
    words: raw.length,
    images,
    specific,
    observation,
    generic,
    wordSet: new Set(normWords.filter((w) => utf8.encode(w).length > 2)),
  };
}

const typingSecs = (p) => Math.min(300, Math.max(5, Math.round(p.chars / 4)));

function similarity(a, b) {
  if (!a.wordSet || !b.wordSet || a.wordSet.size === 0 || b.wordSet.size === 0) return 0;
  let shared = 0;
  for (const w of a.wordSet) if (b.wordSet.has(w)) shared++;
  return shared / (a.wordSet.size + b.wordSet.size - shared);
}

function isSpecific(token) {
  const cs = [...token];
  let a = 0;
  let b = cs.length;
  while (a < b && !KEEP.test(cs[a])) a++;
  while (b > a && !KEEP.test(cs[b - 1])) b--;
  const w = cs.slice(a, b).join("").replace(/\.+$/, "");
  if ([...w].length < 2) return false;
  const digit = /[0-9]/.test(w);
  const path = w.includes("/") || hasExtension(w);
  const ident = w.includes("_") || w.includes("::") || w.endsWith("()") || /\p{Ll}\p{Lu}/u.test(w);
  return digit || path || ident;
}

function hasExtension(w) {
  const i = w.lastIndexOf(".");
  if (i < 0) return false;
  const ext = w.slice(i + 1);
  return i > 0 && /^[A-Za-z0-9]{1,5}$/.test(ext) && /[A-Za-z]/.test(ext);
}

// ---------- reading logs (src/claude.rs) ----------

const str = (v) => (typeof v === "string" ? v : null);

const SKIP = [
  "<task-notification>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-stdout>",
  "<bash-stderr>",
  "Caveat:",
  // The summary Claude Code puts in after squeezing a long conversation down.
  "This session is being continued from a previous conversation",
];

// Lines that can't be a user, assistant or title entry get skipped without parsing.
// Claude Code writes compact JSON, so the type always looks like "type":"user".
const WANTED = ['"type":"user"', '"type":"assistant"', '"type":"custom-title"', '"type":"ai-title"'];

/** Feed one session file line by line, then call finish(). */
export class SessionReader {
  constructor(path) {
    this.path = path;
    this.events = [];
    this.cwd = null;
    this.customTitle = null;
    this.aiTitle = null;
  }

  line(s) {
    if (!s || !WANTED.some((w) => s.includes(w))) return;
    let v;
    try {
      v = JSON.parse(s);
    } catch {
      return;
    }
    if (!v || typeof v !== "object") return;
    const ty = str(v.type) ?? "";
    if (ty === "custom-title") return void (this.customTitle = str(v.customTitle));
    if (ty === "ai-title") return void (this.aiTitle = str(v.aiTitle));
    if (ty !== "user" && ty !== "assistant") return;
    if (v.isSidechain === true) return;
    const t = typeof v.timestamp === "string" ? Date.parse(v.timestamp) : NaN;
    if (Number.isNaN(t)) return;
    if (this.cwd === null) this.cwd = str(v.cwd);
    const e = ty === "assistant" ? assistantEvent(v, t) : userEvent(v, t);
    if (e) {
      e.id = str(v.uuid);
      this.events.push(e);
    }
  }

  finish() {
    if (this.events.length === 0) return null;
    this.events.sort((a, b) => a.t - b.t);
    return { path: this.path, cwd: this.cwd, title: this.customTitle ?? this.aiTitle, events: this.events };
  }
}

function assistantEvent(v, t) {
  if (v.isApiErrorMessage === true) return null;
  const content = v.message?.content;
  const tools = Array.isArray(content)
    ? content.filter((b) => b?.type === "tool_use" && typeof b.name === "string").map((b) => b.name)
    : [];
  return { t, kind: "agent", tools };
}

function userEvent(v, t) {
  for (const f of ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "isVirtual"]) {
    if (v[f] === true) return null;
  }
  const content = v.message?.content;
  if (content === undefined) return null;

  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
    return v.toolDenialKind === "user-rejected" ? { t, kind: "rejected" } : { t, kind: "agent", tools: [] };
  }

  const originKind = v.origin && typeof v.origin === "object" ? v.origin.kind : undefined;
  if (typeof originKind === "string" && originKind !== "human") return null;
  if (typeof v.turnOrigin === "string" && v.turnOrigin !== "human") return null;
  if (v.promptSource === "system") return null;

  const [raw, images] = extractText(content);
  const text = stripTag(raw, "system-reminder").trim();
  if (SKIP.some((p) => text.startsWith(p))) return null;
  if (text.startsWith("[Request interrupted by user")) return { t, kind: "interrupt" };
  if (text.startsWith("<bash-input>")) return { t, kind: "shell" };
  if (text.startsWith("<command-name>")) return { t, kind: "command" };
  if (text === "" && images === 0) return null;
  return { t, kind: "prompt", prompt: analyzePrompt(text, images) };
}

function extractText(content) {
  if (typeof content === "string") return [content, 0];
  if (!Array.isArray(content)) return ["", 0];
  let text = "";
  let images = 0;
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") {
      if (text !== "") text += "\n";
      text += b.text;
    } else if (b?.type === "image") {
      images++;
    }
  }
  return [text, images];
}

function stripTag(s, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let out = "";
  let rest = s;
  for (;;) {
    const start = rest.indexOf(open);
    if (start < 0) break;
    out += rest.slice(0, start);
    const end = rest.indexOf(close, start);
    rest = end < 0 ? "" : rest.slice(end + close.length);
  }
  return out + rest;
}

// ---------- counting (src/analyze.rs) ----------

const AGENT_TIMEOUT = 600;
const WATCH_WINDOW = 120;
const REVIEW_CAP = 600;
const TESTED_CAP = 1200;
const LOW_INFO_CAP = 120;
const BREAK_BACK = 120;
const BREAK_BACK_TESTED = 300;
const LOOP_GAP = 900;
const LOOP_MIN = 3;
const FIRST_PROMPT_MAX = 120;
const DARK_FLOW_KEEP = 30;

export const TOOL_GROUPS = ["edit", "command", "read", "browser action", "web search", "subagent", "other call"];

function toolGroup(name) {
  switch (name) {
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit": return 0;
    case "Bash": case "BashOutput": case "KillShell": case "PowerShell": return 1;
    case "Read": case "Grep": case "Glob": case "LS": return 2;
    case "WebSearch": case "WebFetch": return 4;
    case "Task": case "Agent": case "SendMessage": return 5;
  }
  if (name.includes("rowser") || name.includes("chrome") || name.includes("computer")) return 3;
  return 6;
}

const secs = (a, b) => Math.trunc((a - b) / 1000);
const isHuman = (e) => e.kind !== "agent";

function segment(ev, from, to, start) {
  const seg = { agent: 0, last: null, tools: [0, 0, 0, 0, 0, 0, 0] };
  let prev = start;
  for (let i = from; i < to; i++) {
    const e = ev[i];
    if (e.kind !== "agent") continue;
    const d = secs(e.t, prev);
    if (d >= 0 && d <= AGENT_TIMEOUT) seg.agent += d;
    prev = e.t;
    seg.last = e.t;
    for (const n of e.tools) seg.tools[toolGroup(n)]++;
  }
  return seg;
}

export function analyzeSession(session) {
  const ev = session.events;
  const start = ev.length ? ev[0].t : Date.now();
  const humans = [];
  for (let i = 0; i < ev.length; i++) if (isHuman(ev[i])) humans.push(i);
  const segs = humans.map((i, k) => segment(ev, i + 1, k + 1 < humans.length ? humans[k + 1] : ev.length, ev[i].t));

  const turns = [];
  const loopy = [];
  const typing = [];
  let lastPrompt = null;
  let ranCommand = false;

  humans.forEach((i, k) => {
    const e = ev[i];
    let prev = null;
    if (k > 0) {
      const prevT = ev[humans[k - 1]].t;
      const seg = segs[k - 1];
      const anchor = seg.last ?? prevT;
      prev = {
        gap: Math.max(0, secs(e.t, anchor)),
        agentPrev: seg.agent,
        wall: Math.max(0, secs(e.t, prevT)),
        fromAgent: seg.last !== null,
      };
    }
    const tags = [];
    let isLoopy = false;
    let typed = 0;
    let human;
    let why;
    let fromAgent = prev !== null && prev.fromAgent;
    const afterPrompt = k > 0 && ev[humans[k - 1]].kind === "prompt";
    let words = 0;

    switch (e.kind) {
      case "prompt": {
        const p = e.prompt;
        const tested = p.observation || ranCommand;
        // Live events don't carry the words, so the client works out "repeat" itself.
        const repeat =
          typeof p.repeat === "boolean" ? p.repeat : lastPrompt !== null && p.words >= 3 && similarity(p, lastPrompt) >= 0.6;
        if (p.images > 0) tags.push("screenshot");
        else if (p.observation) tags.push("reported a result");
        if (ranCommand) tags.push("ran a command first");
        if (p.specific >= 2) tags.push("specific");
        if (p.generic) tags.push("low info");
        if (repeat) tags.push("repeat");

        typed = typingSecs(p);
        // Every prompt is capped at the time since your last action, so pasting long
        // prompts back to back can't count more than the time that passed.
        if (!prev) {
          human = Math.min(typed, FIRST_PROMPT_MAX);
          why = { rule: "first" };
        } else if (afterPrompt && !prev.fromAgent) {
          // The agent never answered the last prompt, so only typing counts.
          human = Math.min(typed, FIRST_PROMPT_MAX, prev.wall);
          why = { rule: "noreply", wall: prev.wall };
        } else {
          const { gap, wall } = prev;
          const cap = p.generic ? LOW_INFO_CAP : tested ? TESTED_CAP : REVIEW_CAP;
          if (gap > cap) {
            const back = tested ? BREAK_BACK_TESTED : BREAK_BACK;
            human = Math.min(typed + back, Math.max(cap, typed), wall);
            why = { rule: "break", gap, cap, back };
          } else {
            const watch = gap <= WATCH_WINDOW ? Math.min(prev.agentPrev, WATCH_WINDOW) : 0;
            const reply = gap + watch;
            const want = Math.max(reply, typed);
            human = Math.min(want, wall);
            if (human < want) why = { rule: "wall", wall };
            else if (typed > reply) why = { rule: "typing", gap, watch };
            else why = { rule: "reply", gap, watch, cap };
          }
        }
        isLoopy = (p.generic || repeat) && !tested;
        lastPrompt = p;
        ranCommand = false;
        words = p.words;
        break;
      }
      case "interrupt":
        // Measured from your last action, whatever the agent did since.
        fromAgent = false;
        [human, why] = clamped(prev ? prev.wall : null, 10, 5, 300);
        break;
      case "shell":
        ranCommand = true;
        [human, why] = clamped(prev ? prev.gap : null, 10, 10, 300);
        break;
      case "command":
        [human, why] = clamped(prev ? prev.gap : null, 5, 5, 30);
        break;
      case "rejected":
        [human, why] = clamped(prev ? prev.gap : null, 10, 10, 60);
        break;
    }

    turns.push({
      t: e.t,
      kind: e.kind,
      words,
      tags,
      human,
      flagged: 0,
      agent: segs[k].agent,
      tools: segs[k].tools,
      darkFlow: false,
      // Which rule set `human`, for the notes. Doesn't change any counting.
      why,
      fromAgent,
      typed,
      run: 0,
      // Time another session at the same moment already counted. Set by countOverlapOnce.
      overlap: 0,
    });
    loopy.push(isLoopy);
    typing.push(typed);
  });

  markDarkFlow(turns, loopy, typing);
  return { title: session.title, start, turns };
}

// Time for actions other than prompts: `since` kept between min and max, or a flat
// `first` if it's the first thing in the session.
function clamped(since, first, min, max) {
  if (since === null) return [Math.max(first, min), { rule: "first" }];
  return [Math.max(Math.min(since, max), min), { rule: "clamped", secs: since, min, max }];
}

function markDarkFlow(turns, loopy, typing) {
  const prompts = [];
  turns.forEach((t, i) => t.kind === "prompt" && prompts.push(i));
  let a = 0;
  while (a < prompts.length) {
    if (!loopy[prompts[a]]) {
      a++;
      continue;
    }
    let b = a;
    while (b + 1 < prompts.length && loopy[prompts[b + 1]] && secs(turns[prompts[b + 1]].t, turns[prompts[b]].t) <= LOOP_GAP) {
      b++;
    }
    if (b - a + 1 >= LOOP_MIN) {
      for (const i of prompts.slice(a, b + 1)) {
        const t = turns[i];
        const keep = Math.min(typing[i], DARK_FLOW_KEEP, t.human);
        t.flagged = t.human - keep;
        t.human = keep;
        t.darkFlow = true;
        t.run = b - a + 1;
      }
    }
    a = b + 1;
  }
}

export const sessionHuman = (s) => s.turns.reduce((n, t) => n + t.human, 0);
export const sessionAgent = (s) => s.turns.reduce((n, t) => n + t.agent, 0);
export const sessionFlagged = (s) => s.turns.reduce((n, t) => n + t.flagged, 0);
export const sessionOverlap = (s) => s.turns.reduce((n, t) => n + t.overlap, 0);
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
export const projectHuman = (p) => sum(p.sessions, sessionHuman);
export const projectAgent = (p) => sum(p.sessions, sessionAgent);
export const projectFlagged = (p) => sum(p.sessions, sessionFlagged);
export const projectOverlap = (p) => sum(p.sessions, sessionOverlap);

/**
 * Several sessions at once (two windows, two tools, two computers) would each count the
 * same minutes. A turn's time covers the stretch right before it, so going through every
 * turn of every session in time order, only the part no earlier turn already covered
 * counts. The rest moves to `overlap`. Same as count_overlap_once in src/analyze.rs.
 */
export function countOverlapOnce(turns) {
  const all = turns.filter((t) => t.human > 0).sort((a, b) => a.t - b.t);
  const covered = []; // [start, end] in ms, merged and in order
  for (const turn of all) {
    const end = turn.t;
    const start = end - turn.human * 1000;
    let already = 0;
    for (let i = covered.length - 1; i >= 0 && covered[i][1] > start; i--) {
      already += covered[i][1] - Math.max(covered[i][0], start);
    }
    const fresh = Math.floor((end - start - already) / 1000);
    turn.overlap = turn.human - fresh;
    turn.human = fresh;
    let mergedStart = start;
    while (covered.length && covered[covered.length - 1][1] >= start) mergedStart = Math.min(mergedStart, covered.pop()[0]);
    covered.push([mergedStart, end]);
  }
}

// Same order as Rust sorting PathBufs: compare folder by folder.
function comparePaths(a, b) {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

function projectName(cwd) {
  if (!cwd) return "unknown";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

/**
 * sessions: output of SessionReader.finish(). Doesn't change them.
 * Resumed or forked sessions copy old entries into a new file, so sessions are
 * gone through oldest first and each entry only counts the first time it shows up.
 */
export function buildReport(sessions, { days = 30, now = Date.now() } = {}) {
  const ordered = [...sessions]
    .sort((a, b) => comparePaths(a.path, b.path))
    .sort((a, b) => a.events[0].t - b.events[0].t);
  const cutoff = days == null ? null : now - days * 86400000;
  const seen = new Set();
  const byName = new Map();

  for (const s of ordered) {
    const events = s.events.filter((e) => e.id === null || (!seen.has(e.id) && seen.add(e.id)));
    if (events.length === 0) continue;
    if (cutoff !== null && events[events.length - 1].t < cutoff) continue;
    const rep = analyzeSession({ ...s, events });
    if (rep.turns.length === 0) continue;
    const name = projectName(s.cwd);
    if (!byName.has(name)) byName.set(name, { name, sessions: [] });
    byName.get(name).sessions.push(rep);
  }

  const projects = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  countOverlapOnce(projects.flatMap((p) => p.sessions.flatMap((s) => s.turns)));
  for (const p of projects) p.sessions.sort((a, b) => b.start - a.start);
  projects.sort((a, b) => projectHuman(b) - projectHuman(a));
  return projects;
}

// ---------- report (src/report.rs) ----------

export function fmtDur(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  if (s > 0) return `${s}s`;
  return "0m";
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plural = (n, w) => (n === 1 ? `1 ${w}` : `${n} ${w}s`);
const pct = (part, whole) => (whole <= 0 ? 0 : Math.min(100, Math.max(0, (part / whole) * 100)));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fullDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d)}`;

const ACTIONS = {
  interrupt: "Stopped agent",
  shell: "Ran command",
  command: "Slash command",
  rejected: "Rejected tool call",
};

// ---------- checks for reviewers ----------

/**
 * Things about a day that a reviewer might want to look at, worked out from the same
 * turns the totals come from. Someone can script fake events with their own key, so
 * these are how it would show. Most have honest reasons too, so they're worded as things
 * to look at. Days are UTC. Returns [{ day: "2026-11-20", notes: ["..."] }], newest first.
 */
export function checks(projects) {
  const days = new Map();
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const t of s.turns) {
        const day = new Date(t.t).toISOString().slice(0, 10);
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(t);
      }
    }
  }
  const out = [];
  for (const [day, turns] of days) {
    turns.sort((a, b) => a.t - b.t);
    const notes = [];
    const human = turns.reduce((n, t) => n + t.human, 0);
    const overlap = turns.reduce((n, t) => n + t.overlap, 0);
    if (human > 12 * 3600) notes.push(`${fmtDur(human)} counted in one day`);

    const span = (turns[turns.length - 1].t - turns[0].t) / 1000;
    let longestBreak = 0;
    for (let i = 1; i < turns.length; i++) longestBreak = Math.max(longestBreak, (turns[i].t - turns[i - 1].t) / 1000);
    if (span > 16 * 3600 && longestBreak < 2 * 3600) {
      notes.push(`active for ${fmtDur(span)} with no break longer than ${fmtDur(Math.round(longestBreak))}`);
    }

    const prompts = turns.filter((t) => t.kind === "prompt");
    const answered = (t) => t.agent > 0 || t.tools.some((n) => n > 0);
    const unanswered = prompts.filter((t) => !answered(t)).length;
    if (prompts.length >= 10 && unanswered > prompts.length / 4) {
      notes.push(`${unanswered} of ${prompts.length} prompts got no answer from an agent`);
    }
    const tooFast = prompts.filter((t) => t.why.rule === "wall").length;
    if (prompts.length >= 10 && tooFast > prompts.length * 0.3) {
      notes.push(`${tooFast} of ${prompts.length} prompts came faster than they could be typed`);
    }

    const replies = prompts.filter((t) => t.fromAgent && (t.why.rule === "reply" || t.why.rule === "typing")).map((t) => t.why.gap);
    if (replies.length >= 30) {
      replies.sort((a, b) => a - b);
      const median = replies[Math.floor(replies.length / 2)];
      if (median < 15) notes.push(`replies usually came ${median}s after the agent stopped`);
    }
    if (prompts.length >= 30) {
      const gaps = prompts.slice(1).map((t, i) => (t.t - prompts[i].t) / 1000);
      const mean = gaps.reduce((n, g) => n + g, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((n, g) => n + (g - mean) ** 2, 0) / gaps.length);
      if (mean > 0 && sd / mean < 0.5) notes.push("prompts came at very even intervals");
    }
    if (overlap > 30 * 60) notes.push(`${fmtDur(overlap)} in sessions at the same time, counted once`);
    if (notes.length) out.push({ day, notes });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}

function renderChecks(projects) {
  const found = checks(projects);
  let h = `<h2>Checks</h2>\n`;
  if (!found.length) return h + "<p>Nothing stood out.</p>\n";
  h += `<p class="muted">Things a reviewer might want to look at. Most have honest reasons, like a long hackathon day or running two agents at once.</p>\n<ul>\n`;
  for (const { day, notes } of found) h += `<li>${day}: ${notes.map(esc).join(", ")}</li>\n`;
  return h + "</ul>\n";
}

/** The report itself, as an HTML fragment. */
export function renderReport(
  projects,
  {
    window: span,
    hideTitles = false,
    source = "your Claude Code logs",
    sessions: showSessions = true,
    projectLink = null,
    checks: showChecks = true,
  },
) {
  const human = sum(projects, projectHuman);
  const agent = sum(projects, projectAgent);
  const flagged = sum(projects, projectFlagged);
  const overlap = sum(projects, projectOverlap);
  const sessions = sum(projects, (p) => p.sessions.length);
  let h = "";

  h += `<h2>Totals</h2>
<p>${plural(sessions, "session")} in ${plural(projects.length, "project")}, ${esc(span)}. Made from ${esc(source)}. Prompt text isn't included.</p>
<table class="totals">
<tr><th>Your time</th><td>${fmtDur(human)}</td></tr>
<tr><th>Agent time</th><td>${fmtDur(agent)}</td></tr>
<tr><th>1/3 rule</th><td>${fmtDur(Math.trunc(agent / 3))}</td></tr>
<tr><th>Dark flow (not counted)</th><td>${fmtDur(flagged)}</td></tr>
<tr><th>Sessions at the same time (counted once)</th><td>${fmtDur(overlap)}</td></tr>
</table>
`;

  const scale = Math.max(1, ...projects.map((p) => Math.max(projectHuman(p), projectAgent(p))));
  if (showChecks) h += renderChecks(projects);

  h += `<h2>Projects</h2>
<div class="scroll"><table class="list">
<tr><th>Project</th><th class="r">Sessions</th><th class="r">Your time</th><th class="r">Agent time</th><th class="r">1/3 rule</th><th class="bars">Black: you, gray: agent</th></tr>
`;
  for (const p of projects) {
    const ph = projectHuman(p);
    const pa = projectAgent(p);
    const name = projectLink ? `<a href="${esc(projectLink(p.name))}">${esc(p.name)}</a>` : esc(p.name);
    h += `<tr><td>${name}</td><td class="r">${p.sessions.length}</td><td class="r">${fmtDur(ph)}</td><td class="r">${fmtDur(pa)}</td><td class="r">${fmtDur(Math.trunc(pa / 3))}</td><td class="bars"><div class="bar you" style="width:${pct(ph, scale).toFixed(2)}%"></div><div class="bar agent" style="width:${pct(pa, scale).toFixed(2)}%"></div></td></tr>\n`;
  }
  h += "</table></div>\n";
  if (!showSessions) return h;

  h += `<h2>Sessions</h2>\n<p class="muted">In each bar, black is your time, gray is agent time and red is dark flow. Breaks are left out.</p>\n`;
  for (const p of projects) {
    h += `<h3>${esc(p.name)} <span class="muted">(you ${fmtDur(projectHuman(p))}, agent ${fmtDur(projectAgent(p))})</span></h3>\n`;
    for (const s of p.sessions) h += renderSession(s, hideTitles);
  }
  return h + HOW;
}

function renderSession(s, hideTitles) {
  const title = s.title && !hideTitles ? esc(s.title) : "Session";
  const start = new Date(s.start);
  let h = `<details><summary>${fullDate(start)} &nbsp; ${title} &nbsp; <span class="muted">you ${fmtDur(sessionHuman(s))}, agent ${fmtDur(sessionAgent(s))}, ${plural(s.turns.length, "action")}</span></summary>\n`;

  h += '<div class="strip">';
  for (const t of s.turns) {
    const total = t.human + t.flagged + t.agent;
    if (total <= 0) continue;
    const you = t.darkFlow ? t.human + t.flagged : t.human;
    h += `<span class="blk" style="flex-grow:${total}"><i class="${t.darkFlow ? "h flow" : "h"}" style="flex-grow:${you}"></i><i class="a" style="flex-grow:${t.agent}"></i></span>`;
  }
  h += "</div>\n";

  h += '<div class="scroll"><table class="list turns">\n<tr><th>Time</th><th>Action</th><th>Notes</th><th class="r">Your time</th><th class="r">Agent time after</th><th>Agent did</th></tr>\n';
  const startDay = dayKey(start);
  for (const t of s.turns) {
    const d = new Date(t.t);
    const when = dayKey(d) === startDay ? hm(d) : fullDate(d);
    const action = t.kind === "prompt" ? `Prompt (${plural(t.words, "word")})` : ACTIONS[t.kind];
    const note = turnNote(t);
    const before = t.human + t.flagged + t.overlap;
    const you = before !== t.human ? `${fmtDur(t.human)} (was ${fmtDur(before)})` : fmtDur(t.human);
    const did = TOOL_GROUPS.map((g, i) => [g, t.tools[i]]).filter(([, n]) => n > 0).map(([g, n]) => plural(n, g));
    h += `<tr${t.darkFlow ? ' class="flow"' : ""}><td>${when}</td><td>${action}</td><td title="${esc(note.long)}">${note.short}</td><td class="r">${you}</td><td class="r">${t.agent > 0 ? fmtDur(t.agent) : ""}</td><td>${did.join(", ")}</td></tr>\n`;
  }
  return h + "</table></div>\n</details>\n";
}

// Seconds for the hover text: "40s", "9m 12s", "1h 05m".
function exact(n) {
  n = Math.max(0, n);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// Like fmtDur, but 0 is "0s".
const ago = (n) => (n <= 0 ? "0s" : fmtDur(n));

const TAG_WORDS = {
  screenshot: "has a screenshot",
  "reported a result": "says what happened",
  "ran a command first": "you ran a command first",
  specific: "names files or code",
  "low info": 'short, like "continue"',
  repeat: "almost the same as your last prompt",
};

// How the prompt shows you tested something, if it does. Same as `tested` above.
function testedHow(t) {
  if (t.tags.includes("screenshot")) return "you sent a screenshot";
  if (t.tags.includes("reported a result")) return "you said what happened";
  if (t.tags.includes("ran a command first")) return "you ran a command first";
  return null;
}

/**
 * Why a turn got the time it did: `short` for the notes column (HTML), `long` for
 * hovering over it (plain text). src/report.rs has the same words in note().
 */
export function turnNote(t) {
  // Time before dark flow or another session cut it down.
  const base = t.human + t.flagged + t.overlap;
  const since = t.fromAgent ? "after the agent stopped" : "after your last action";
  const shortPrompt = t.tags.includes("low info");
  const tested = testedHow(t);
  const capWhy = (cap) => {
    if (cap === TESTED_CAP && tested) return ` it's ${exact(cap)} because ${tested}.`;
    if (cap === LOW_INFO_CAP) return ` it's ${exact(cap)} because it's a short prompt like "continue".`;
    return "";
  };
  const w = t.why;
  let short;
  let long;

  if (w.rule === "first" && t.kind === "prompt") {
    short = "first prompt, just typing time";
    long = `nothing before it to measure from, so only typing time counts (${exact(t.typed)}), up to ${exact(FIRST_PROMPT_MAX)}.`;
  } else if (w.rule === "noreply") {
    short = "no reply to your last prompt, just typing time";
    long = `the agent didn't answer your last prompt, so there was nothing to read or test. only typing time counts (${exact(t.typed)}), up to ${exact(FIRST_PROMPT_MAX)} and never more than the ${exact(w.wall)} since your last prompt.`;
  } else if (w.rule === "first") {
    short = `first action, counts ${ago(base)}`;
    long = `nothing before it to measure from, so it gets a flat ${exact(base)}.`;
  } else if (w.rule === "break") {
    const came = `your prompt came ${exact(w.gap)} ${since}`;
    if (base === t.typed + w.back) {
      short = tested ? `back after a break, tested: ${ago(w.back)} + typing` : `back after a break: ${ago(w.back)} + typing`;
      long = `${came}, over the ${exact(w.cap)} max, so it counts as a break. we can't tell when you came back, so ${exact(w.back)} to catch up plus typing (${exact(t.typed)}) counts.`;
      if (tested) long += ` the max is ${exact(w.cap)} and catch-up is ${exact(w.back)} because ${tested}.`;
    } else if (base > t.typed) {
      short = shortPrompt ? `short prompt after a break, capped at ${ago(w.cap)}` : `back after a break, capped at ${ago(w.cap)}`;
      long = `${came}, over the ${exact(w.cap)} max.${capWhy(w.cap)}`;
    } else {
      short = "typing time, longer than the max";
      long = `${came}, over the ${exact(w.cap)} max, but typing it takes about ${exact(t.typed)}.`;
    }
  } else if (w.rule === "reply" && w.watch > 0) {
    short = `replied ${ago(w.gap)} ${since} + ${ago(w.watch)} watching`;
    long = `you replied ${exact(w.gap)} ${since}. that's within ${exact(WATCH_WINDOW)}, so you were probably watching it work, and ${exact(w.watch)} of its run time counts too.`;
  } else if (w.rule === "reply") {
    short = tested && w.gap > REVIEW_CAP ? `tested, replied ${ago(w.gap)} ${since}` : `replied ${ago(w.gap)} ${since}`;
    long = t.fromAgent
      ? `the ${exact(w.gap)} between the agent stopping and your prompt counts, up to ${exact(w.cap)}.`
      : `the agent didn't do anything after your last action, so the ${exact(w.gap)} since then counts, up to ${exact(w.cap)}.`;
    long += capWhy(w.cap);
  } else if (w.rule === "typing") {
    short = "typing time, longer than the wait";
    long = `you replied ${exact(w.gap)} ${since}${w.watch > 0 ? ` (+${exact(w.watch)} watching)` : ""}, but typing it takes about ${exact(t.typed)}, so typing time counts.`;
  } else if (w.rule === "wall") {
    short = `${ago(w.wall)} since your last action`;
    long = "a prompt never counts more than the time since your last action.";
  } else {
    const asked = t.kind === "rejected" && t.fromAgent;
    const after = asked ? "after the agent asked" : since;
    const from = asked ? "since the agent asked" : t.fromAgent ? "since the agent stopped" : "since your last action";
    if (w.secs > w.max) short = `${exact(w.secs)} ${after}, capped at ${ago(w.max)}`;
    else if (w.secs < w.min) short = `under ${ago(w.min)}, counts as ${ago(w.min)}`;
    else short = `${ago(w.secs)} ${after}`;
    const range = `${exact(w.min)} to ${exact(w.max)}`;
    long = {
      interrupt: `stopping the agent means you were watching it, so the time since your last action counts, ${range}.`,
      shell: `you ran a command yourself, so the time ${from} counts, ${range}. your next prompt counts as tested.`,
      command: `slash commands count the time ${from}, ${range}.`,
      rejected: `you read what the agent wanted to do and said no. the time ${from} counts, ${range}.`,
    }[t.kind] ?? `the time ${from} counts, ${range}.`;
  }

  if (t.darkFlow) {
    const was = t.flagged > 0 ? ` it would have been ${exact(base)}: ${short}.` : "";
    short = `<span class="red">dark flow</span>: ${shortPrompt ? "short" : "repeat"} prompt in a run of ${t.run}, typing only`;
    long = `${t.run} short or repeat prompts in a row, each within ${exact(LOOP_GAP)} of the last, and none show testing. that looks like hitting retry, so only typing time counts, up to ${exact(DARK_FLOW_KEEP)}.${was}`;
  }
  if (t.overlap > 0) {
    short += ", overlaps another session";
    long += `\nanother session was already counting ${exact(t.overlap)} of this same time, so that part counts there and not here.`;
  }
  if (t.kind === "prompt" && t.tags.length > 0) long += `\nprompt: ${t.tags.map((g) => TAG_WORDS[g] ?? g).join(", ")}`;
  return { short, long };
}

const HOW = `<h2>How it counts</h2>
<ul>
<li>Your time comes from things you do: prompts, stopping the agent, rejecting a tool call, running a command.</li>
<li>Time between the agent finishing and your next prompt counts, up to 10 min. Up to 20 min if the prompt has a screenshot, describes what happened, or you ran a command first. Up to 2 min for short prompts like "continue" (3 words or less with no file names, numbers or code).</li>
<li>A longer gap is a break. Then only 2 min plus typing time counts (5 min if you tested something). Short prompts get 2 min at most.</li>
<li>If you reply within 2 min of the agent finishing, up to 2 min of agent time counts too.</li>
<li>Typing time is guessed from how long the prompt is, about 48 words a minute, between 5s and 5 min.</li>
<li>A prompt never counts more than the time since your last action. The first prompt of a session, or one right after a prompt the agent never answered, only counts typing time, up to 2 min.</li>
<li>Stopping the agent counts the time since your last action, up to 5 min. A command you run counts up to 5 min, a slash command up to 30s and a rejected tool call up to 1 min.</li>
<li>Agent time never counts as your time.</li>
<li>3 or more short or repeated prompts in a row, each within 15 min of the last and without testing, is dark flow. Only typing time counts for those, up to 30s each.</li>
<li>Sessions running at the same time (two windows, two tools or two computers) only count the same minutes once.</li>
<li>If a session was resumed or forked, the copied messages only count once.</li>
<li>The notes say why each row got its time. Hover over a note for the numbers.</li>
<li>Prompts are only used for word counts and notes. The text isn't saved.</li>
<li>1/3 rule is agent time divided by 3, which is roughly what reviewers do now with Hackatime AI time.</li>
</ul>
`;


/** A standalone HTML file of the report, for saving. */
export function renderDocument(projects, opts, css) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>steer report</title>
<style>
${css}
</style>
</head>
<body>
<main>
<h1>steer report</h1>
${renderReport(projects, opts)}</main>
</body>
</html>
`;
}
