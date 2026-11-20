#!/bin/sh
# Asks what you're doing every 4 to 8 minutes while it runs, so steer's numbers can be
# checked against what really happened. Answers stay in truth/answers.jsonl in this
# repo (it's gitignored). Nothing gets sent anywhere. Mac only for now.
#   sh tools/truth.sh        start it when you start working, ctrl+c when you stop
#   node tools/truth-compare.mjs   afterwards, to compare with what steer counted
set -eu

dir="$(cd "$(dirname "$0")/.." && pwd)/truth"
mkdir -p "$dir"
out="$dir/answers.jsonl"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "{\"t\":\"$(now)\",\"event\":\"start\"}" >>"$out"
trap 'echo "{\"t\":\"$(now)\",\"event\":\"stop\"}" >>"$out"; echo; echo "stopped. answers are in $out"; exit 0' INT TERM
echo "asking every 4 to 8 minutes. ctrl+c when you stop working."
echo "answers go to $out"

while :; do
  sleep $((240 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 241))
  asked=$(now)
  # No default button, so pressing enter while typing doesn't answer it by accident.
  answer=$(osascript -e 'button returned of (display dialog "what are you doing right now?" with title "steer check" buttons {"away", "something else", "working with the ai"} giving up after 90)' 2>/dev/null || true)
  [ -z "$answer" ] && answer="no answer"
  echo "{\"t\":\"$asked\",\"answer\":\"$answer\"}" >>"$out"
done
