// Passes what page.js noticed on to the extension's worker. Only messages from this same
// page, in the shape page.js sends, get through.
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.steer !== 1 || !["prompt", "stop", "focus", "copy", "typing"].includes(d.type)) return;
  if (d.type === "focus" && typeof d.on !== "boolean") return;
  if (d.site !== "chatgpt" && d.site !== "claude-ai") return;
  chrome.runtime
    .sendMessage({
      type: d.type,
      site: d.site,
      id: String(d.id ?? "").slice(0, 40),
      session: String(d.session ?? "").slice(0, 60),
      text: typeof d.text === "string" ? d.text.slice(0, 200_000) : "",
      previous: typeof d.previous === "string" ? d.previous.slice(0, 200_000) : "",
      images: Math.min(100, Math.max(0, Number(d.images) || 0)),
      on: d.type === "focus" ? d.on : undefined,
      at: d.type === "focus" && Number.isFinite(d.at) ? d.at : undefined,
    })
    .catch(() => {});
});
