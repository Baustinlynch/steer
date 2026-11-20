#!/bin/sh
# installs steer (https://github.com/EwoudVV/steer) into ~/.steer/bin and sets it up
#   curl -fsSL https://steer.duck.hackclub.app/install.sh | sh
set -eu

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) file=steer-macos-arm64 ;;
  Darwin-x86_64) file=steer-macos-x64 ;;
  Linux-x86_64) file=steer-linux-x64 ;;
  Linux-aarch64 | Linux-arm64) file=steer-linux-arm64 ;;
  *)
    echo "steer doesnt have a build for $(uname -s) $(uname -m) yet"
    exit 1
    ;;
esac

bin="$HOME/.steer/bin"
mkdir -p "$bin"
echo "downloading steer..."
curl -fsSL "https://github.com/EwoudVV/steer/releases/latest/download/$file" -o "$bin/steer.new"
chmod +x "$bin/steer.new"
mv "$bin/steer.new" "$bin/steer"

if [ ! -f "$HOME/.steer/config.json" ]; then
  echo "sign in with your hack club account:"
  "$bin/steer" login < /dev/tty
fi

"$bin/steer" setup
echo "done. check on it anytime with: ~/.steer/bin/steer status"
