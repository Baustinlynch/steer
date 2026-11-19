# steer

demo for hack club's ai time tracking bounty. it reads your claude code logs and makes a report of how much time you actually spent working with the agent, next to how long the agent ran by itself.

## running it

```bash
cargo build --release
```

```bash
./target/release/steer --days 30
```

then open steer-report.html. use `--hide-titles` if you want to share a screenshot. `--help` shows the rest.

## privacy

everything stays on your computer. it reads `~/.claude/projects` and runs `git log` in your project folders. prompts are only used for word counts and notes like "screenshot" or "low info", the text isnt saved and isnt in the report.

## how time is counted

the "how it counts" part at the bottom of the report explains it, and the code is in `src/analyze.rs`. short version: the time between the agent finishing and your next prompt counts (with caps), the time the agent runs by itself doesnt.

## todo

- live tracking (right now it only reads old logs)
- codex, cursor, opencode, vs code
- server with accounts and a reviewer view
- check accuracy against reviewer labels
- prebuilt downloads for windows, mac and linux

## license

AGPL-3.0
