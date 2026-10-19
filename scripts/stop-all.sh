#!/usr/bin/env bash
set -euo pipefail

# If the agent LaunchAgent is loaded, KeepAlive will relaunch MacActivityAgent after kill.
AGENT_PLIST="$HOME/Library/LaunchAgents/com.macactivitytracker.agent.plist"
if [[ -f "$AGENT_PLIST" ]]; then
  if launchctl print "gui/$(id -u)/com.macactivitytracker.agent" >/dev/null 2>&1 \
    || launchctl list 2>/dev/null | grep -q 'com.macactivitytracker.agent'; then
    echo "Note: com.macactivitytracker.agent LaunchAgent is loaded — unloading so KeepAlive does not restart it."
    launchctl bootout "gui/$(id -u)/com.macactivitytracker.agent" 2>/dev/null || true
    launchctl unload "$AGENT_PLIST" 2>/dev/null || true
  fi
fi

for f in /tmp/macactivitytracker-server.pid /tmp/macactivitytracker-agent.pid; do
  if [[ -f "$f" ]]; then
    pid=$(cat "$f")
    kill "$pid" 2>/dev/null || true
    rm -f "$f"
    echo "Stopped PID $pid"
  fi
done
pkill -f 'MacActivityAgent' 2>/dev/null || true
pkill -f 'server/src/index.js' 2>/dev/null || true
echo "Done."
