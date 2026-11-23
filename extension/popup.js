// Shows whether the steer app answers, and lets you pick which project browser chats
// count toward.
const HOST = "app.steer.native";
const state = document.getElementById("state");
const select = document.getElementById("project");

chrome.runtime.sendNativeMessage(HOST, { kind: "projects" }, (answer) => {
  if (chrome.runtime.lastError || !answer) {
    state.className = "red";
    state.textContent = "Can't reach the steer app on this computer. Install steer (steer.duck.hackclub.app), then run: steer setup";
    return;
  }
  if (!answer.signed_in) {
    state.className = "red";
    state.textContent = "steer isn't signed in. Run: steer login";
    return;
  }
  state.className = "";
  // Signing in with just a key (steer login KEY) doesn't save the account's name.
  state.textContent = answer.user ? `Tracking ChatGPT and Claude as ${answer.user}.` : "Tracking ChatGPT and Claude.";
  const names = [...new Set([answer.current, ...answer.recent, "browser"])].filter(Boolean);
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name === "browser" ? "no project (browser)" : name;
    option.selected = name === answer.current;
    select.append(option);
  }
  document.getElementById("pick").hidden = false;
});

select.addEventListener("change", () => {
  chrome.runtime.sendNativeMessage(HOST, { kind: "set-project", name: select.value }, () => {});
});
