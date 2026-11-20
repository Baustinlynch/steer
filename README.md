# steer

steer tracks the time you spend working with ai coding agents. the time the agent runs by itself doesnt count, only what you do around it, like writing prompts, reading what it did, testing and fixing stuff. made for hack club's ai time tracking bounty.

works with claude code, codex, opencode, copilot (vs code and cli) and cursor.

## install

mac and linux:

```bash
curl -fsSL https://steer.duck.hackclub.app/install.sh | sh
```

windows (powershell):

```powershell
irm https://steer.duck.hackclub.app/install.ps1 | iex
```

it tells you what it found and what it's going to change, and asks first. then you sign in with your hack club account and it hooks into your tools. your page is at `https://steer.duck.hackclub.app/u/NAME` and updates while you work.

you can also download steer from the [releases page](https://github.com/EwoudVV/steer/releases) and run it. the first time, it does the same setup.

to undo everything:

```bash
steer uninstall
```

## how it works

- claude code and cursor run `steer hook` on every prompt, tool call and when the agent finishes
- codex, opencode and copilot dont have hooks like that, so a small background watcher (`steer watch`) reads their session logs every 5 seconds. it uses about 0.2% cpu
- events go into a queue in `~/.steer` and get sent to the server in the background, so your tools never wait on the network
- the server stamps each event when it arrives. anything more than 5 minutes off doesnt count, so you cant make up old sessions later

## privacy

prompt text never leaves your computer. steer reads it to work out a few counts and then drops it. this is everything a prompt event sends:

`id, session, project, via (which tool), time, words, chars, images, specific, observation, generic, repeat`

project is the name of the git repo or folder you were in (your home folder shows up as "home"). your page is public.

## how time is counted

the bottom of every report explains it, and the code is in `src/analyze.rs` (and `web/steer.js` for the website and server, which gives the same numbers). short version: the gap between the agent finishing and your next prompt counts, with caps, and loops of "continue" / "fix it" without testing dont count.

## other commands

```bash
steer                              # sets it all up the first time, after that shows the status
steer doctor                       # checks everything and says how to fix what's broken
steer update                       # gets the newest version now
steer uninstall                    # takes steer out of your tools and deletes ~/.steer
steer watch --dry-run --days 30    # what the watcher would send, as counts only
steer report --days 30             # html report from your old claude code logs
```

## updates

the watcher checks github for a new version once a day and swaps it in by itself. that check only asks github which version is newest, nothing about you gets sent. to turn it off, make a file at `~/.steer/no-update` (or set `STEER_NO_UPDATE`) and run `steer update` when you want to.

the website also has a drop-a-folder version of the report that runs in your browser.

## running your own server

```bash
PORT=8790 STEER_DATA=./data node server/server.mjs
```

then `steer signup NAME --server https://your.server`.

## license

AGPL-3.0-or-later, see LICENSE
