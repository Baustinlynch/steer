# Chrome Web Store listing

What to paste into each field of the Chrome Web Store developer dashboard for the steer
extension. The zip to upload comes from `node tools/pack-extension.mjs` (it's the
`extension` folder without the manifest's `key`, which the store doesn't accept).

## Store listing tab

**Name** (from the manifest): steer

**Summary** (from the manifest's description, 132 characters max):
Tracks the time you spend coding with ChatGPT and Claude in the browser, for steer. Prompt text never leaves your computer.

**Description:**

```
steer tracks the time you spend working with AI coding tools, and only counts what you do around the AI: writing prompts, reading answers, testing and fixing things. The time the AI spends writing doesn't count. It's made for Hack Club, where people log hours on projects they build.

This extension adds ChatGPT (chatgpt.com) and Claude (claude.ai) in the browser to steer. When you send a message, it counts the message right in your browser (how many words, whether it mentions an error or a file), notices when the answer is done, and gives only those counts to the steer app on your computer. Your messages and the answers never leave your browser.

You need the steer app for this to work. Install it from https://steer.duck.hackclub.app, run "steer setup", and then the extension's icon shows which project your chats count toward.

Everything steer sends is listed at https://steer.duck.hackclub.app/privacy, and the code is open source (AGPL-3.0) at https://github.com/EwoudVV/steer.
```

**Category:** Developer Tools

**Language:** English

**Store icon:** `extension/icons/128.png`

**Screenshots** (1280x800): `store/screenshot-1.png`

**Small promo tile** (440x280): `store/promo-small.png`

**Homepage URL:** https://steer.duck.hackclub.app

**Support URL:** https://github.com/EwoudVV/steer/issues

## Privacy practices tab

**Single purpose:**

```
Counts how long you spend writing messages to and reading answers from ChatGPT and Claude, and passes those counts to the steer time tracker app on your computer.
```

**Permission justification, nativeMessaging:**

```
To give the counts (how many words a message had, and when it was sent and answered) to the steer app installed on the user's computer, which adds them to the user's steer account. The extension has no server of its own.
```

**Host permission justification** (the content scripts on chatgpt.com and claude.ai):

```
To notice when the user sends a message on chatgpt.com or claude.ai and when the answer is done. It only runs on these two sites, and the message text is only read inside the browser to count it.
```

**Are you using remote code?** No, I am not using remote code.

**Data usage**, what user data the extension collects:

- Website content: yes. Counts worked out from the messages you send (number of words and characters, whether it mentions files or errors). Never the text itself.
- User activity: yes. When a message is sent and when the answer finishes.
- Everything else: no.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://steer.duck.hackclub.app/privacy

## Distribution tab

Public, all regions, free.

## Test instructions (for Google's reviewers)

Signing in normally needs a Hack Club account, so reviewers get a throwaway test
account's key. Make it on the server just before submitting, and paste the key into the
dashboard only, never into this repo.

```
The extension needs the free steer app on the same computer, since it passes its counts to that app. To try it:

1. On macOS or Linux, run in a terminal: curl -fsSL https://steer.duck.hackclub.app/install.sh | sh
   On Windows, run in PowerShell: irm https://steer.duck.hackclub.app/install.ps1 | iex
   When it asks "go ahead?", answer n for now (it would ask for a Hack Club login).
2. Sign in with the test account: ~/.steer/bin/steer login KEY_GOES_HERE
   (on Windows: ~\.steer\bin\steer.exe login KEY_GOES_HERE)
3. Run ~/.steer/bin/steer install and answer y. It hooks into AI tools and registers the steer app with Chrome.
4. Open the extension's popup. It shows "Tracking ChatGPT and Claude." and a project picker.
5. Send a message on chatgpt.com or claude.ai. Within a few seconds it shows up on https://steer.duck.hackclub.app/u/store-review

To remove everything afterwards: ~/.steer/bin/steer uninstall
```
