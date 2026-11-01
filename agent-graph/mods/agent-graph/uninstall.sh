#!/bin/sh
# Remove the agent-graph recorder launchd agent; history and log are kept.
set -eu

LABEL=dev.herdr.agent-graph-recorder
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI="gui/$(id -u)/$LABEL"

if launchctl print "$GUI" >/dev/null 2>&1; then
  launchctl bootout "$GUI"
  echo "booted out $GUI"
else
  echo "$GUI was not loaded"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "deleted $PLIST"
else
  echo "no plist at $PLIST"
fi

echo "kept $HOME/.local/share/herdr-agent-graph (history and log)"
