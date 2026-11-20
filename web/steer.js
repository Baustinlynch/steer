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
      prev = { gap: Math.max(0, secs(e.t, anchor)), agentPrev: seg.agent, wall: Math.max(0, secs(e.t, prevT)) };
    }
    const tags = [];
    let breakBefore = false;
    let isLoopy = false;
    let typed = 0;
    let human;
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
        if (!prev) {
          human = typed;
        } else {
          const cap = p.generic ? LOW_INFO_CAP : tested ? TESTED_CAP : REVIEW_CAP;
          if (prev.gap > cap) {
            breakBefore = true;
            const back = tested ? BREAK_BACK_TESTED : BREAK_BACK;
            human = Math.min(typed + back, Math.max(cap, typed));
          } else {
            const watch = prev.gap <= WATCH_WINDOW ? Math.min(prev.agentPrev, WATCH_WINDOW) : 0;
            human = Math.min(Math.max(prev.gap + watch, typed), Math.max(prev.wall, typed));
          }
        }
        isLoopy = (p.generic || repeat) && !tested;
        lastPrompt = p;
        ranCommand = false;
        words = p.words;
        break;
      }
      case "interrupt":
        human = Math.max(prev ? Math.min(prev.wall, 300) : 10, 5);
        break;
      case "shell":
        ranCommand = true;
        human = Math.max(prev ? Math.min(prev.gap, 300) : 10, 10);
        break;
      case "command":
        human = Math.max(prev ? Math.min(prev.gap, 30) : 5, 5);
        break;
      case "rejected":
        human = Math.max(prev ? Math.min(prev.gap, 60) : 10, 10);
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
      breakBefore,
    });
    loopy.push(isLoopy);
    typing.push(typed);
  });

  markDarkFlow(turns, loopy, typing);
  return { title: session.title, start, turns };
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
        const keep = Math.min(typing[i], t.human);
        t.flagged = t.human - keep;
        t.human = keep;
        t.darkFlow = true;
      }
    }
    a = b + 1;
  }
}

export const sessionHuman = (s) => s.turns.reduce((n, t) => n + t.human, 0);
export const sessionAgent = (s) => s.turns.reduce((n, t) => n + t.agent, 0);
export const sessionFlagged = (s) => s.turns.reduce((n, t) => n + t.flagged, 0);
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
export const projectHuman = (p) => sum(p.sessions, sessionHuman);
export const projectAgent = (p) => sum(p.sessions, sessionAgent);
export const projectFlagged = (p) => sum(p.sessions, sessionFlagged);

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

/** The report itself, as an HTML fragment. */
export function renderReport(
  projects,
  { window: span, hideTitles = false, source = "your Claude Code logs", sessions: showSessions = true, projectLink = null },
) {
  const human = sum(projects, projectHuman);
  const agent = sum(projects, projectAgent);
  const flagged = sum(projects, projectFlagged);
  const sessions = sum(projects, (p) => p.sessions.length);
  let h = "";

  h += `<h2>Totals</h2>
<p>${plural(sessions, "session")} in ${plural(projects.length, "project")}, ${esc(span)}. Made from ${esc(source)}. Prompt text isn't included.</p>
<table class="totals">
<tr><th>Your time</th><td>${fmtDur(human)}</td></tr>
<tr><th>Agent time</th><td>${fmtDur(agent)}</td></tr>
<tr><th>1/3 rule</th><td>${fmtDur(Math.trunc(agent / 3))}</td></tr>
<tr><th>Dark flow (not counted)</th><td>${fmtDur(flagged)}</td></tr>
</table>
`;

  const scale = Math.max(1, ...projects.map((p) => Math.max(projectHuman(p), projectAgent(p))));
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
    const notes = [];
    if (t.breakBefore) notes.push("after break");
    notes.push(...t.tags);
    let noteText = notes.join(", ");
    if (t.darkFlow) noteText += (noteText ? ", " : "") + '<span class="red">dark flow</span>';
    const you = t.darkFlow && t.flagged > 0 ? `${fmtDur(t.human)} (was ${fmtDur(t.human + t.flagged)})` : fmtDur(t.human);
    const did = TOOL_GROUPS.map((g, i) => [g, t.tools[i]]).filter(([, n]) => n > 0).map(([g, n]) => plural(n, g));
    h += `<tr${t.darkFlow ? ' class="flow"' : ""}><td>${when}</td><td>${action}</td><td>${noteText}</td><td class="r">${you}</td><td class="r">${t.agent > 0 ? fmtDur(t.agent) : ""}</td><td>${did.join(", ")}</td></tr>\n`;
  }
  return h + "</table></div>\n</details>\n";
}

const HOW = `<h2>How it counts</h2>
<ul>
<li>Your time comes from things you do: prompts, stopping the agent, rejecting a tool call, running a command.</li>
<li>Time between the agent finishing and your next prompt counts, up to 10 min. Up to 20 min if the prompt has a screenshot, describes what happened, or you ran a command first. Up to 2 min for prompts like "continue".</li>
<li>A longer gap is a break. Then only 2 min plus typing time counts (5 min if you tested something).</li>
<li>If you reply within 2 min of the agent finishing, up to 2 min of agent time counts too.</li>
<li>Agent time never counts as your time.</li>
<li>3 or more low info or repeated prompts in a row without testing is dark flow. Only typing time counts for those.</li>
<li>If a session was resumed or forked, the copied messages only count once.</li>
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
