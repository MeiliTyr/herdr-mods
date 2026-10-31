#!/bin/sh
# Install the agent-graph recorder as a launchd agent. Usage: install.sh [--dry-run]
set -eu

LABEL=dev.herdr.agent-graph-recorder
DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: install.sh [--dry-run]" >&2; exit 2 ;;
esac

DIR=$(cd "$(dirname "$0")" && pwd -P)
[ -f "$DIR/recorder.py" ] || { echo "missing $DIR/recorder.py" >&2; exit 1; }
[ -x /usr/bin/python3 ] || { echo "/usr/bin/python3 is not executable" >&2; exit 1; }
if ! command -v hc >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/hc" ]; then
  echo "hc not found on PATH or at $HOME/.local/bin/hc" >&2
  exit 1
fi

DATA="$HOME/.local/share/herdr-agent-graph"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
TMP=$(mktemp "${TMPDIR:-/tmp}/$LABEL.XXXXXX")
trap 'rm -f "$TMP"' EXIT

/usr/bin/python3 -I -c '
import plistlib, sys
out, directory, home = sys.argv[1:4]
log = home + "/.local/share/herdr-agent-graph/recorder.log"
plist = {
    "Label": "dev.herdr.agent-graph-recorder",
    "ProgramArguments": ["/usr/bin/python3", "-I", directory + "/recorder.py"],
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "ExitTimeOut": 10,
    "EnvironmentVariables": {
        "PATH": home + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    },
    "StandardErrorPath": log,
    "StandardOutPath": log,
}
with open(out, "wb") as f:
    plistlib.dump(plist, f)
' "$TMP" "$DIR" "$HOME"

if [ "$DRY_RUN" -eq 1 ]; then
  cat "$TMP"
  plutil -lint "$TMP"
  exit 0
fi

plutil -lint "$TMP" >/dev/null
GUI="gui/$(id -u)/$LABEL"
mkdir -p "$AGENTS" "$DATA"
mv "$TMP" "$PLIST"
if launchctl print "$GUI" >/dev/null 2>&1; then
  launchctl bootout "$GUI"
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $PLIST"
launchctl print "$GUI" | grep -E 'state|pid'
