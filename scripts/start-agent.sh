#!/usr/bin/env bash
# Start MacActivityAgent continuously (no --run-seconds).
# Prefer LaunchAgent KeepAlive for login persistence: scripts/install-launchagents.sh agent
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_OUT="${MACACTIVITY_AGENT_LOG:-/tmp/macactivitytracker-agent.log}"
LOG_ERR="${MACACTIVITY_AGENT_ERR:-/tmp/macactivitytracker-agent.err}"
PID_FILE="${MACACTIVITY_AGENT_PID:-/tmp/macactivitytracker-agent.pid}"

cd "$ROOT/mac-agent"
swift build --product MacActivityAgent
AGENT_BIN="$ROOT/mac-agent/.build/debug/MacActivityAgent"

if pgrep -xq MacActivityAgent 2>/dev/null || pgrep -f '/MacActivityAgent( |$)' >/dev/null 2>&1; then
  echo "MacActivityAgent already running (pid(s): $(pgrep -f '/MacActivityAgent( |$)' | tr '\n' ' '))"
  exit 0
fi

# nohup + disown: survive parent shell exit (unlike a bare background &)
nohup "$AGENT_BIN" --quiet >>"$LOG_OUT" 2>>"$LOG_ERR" &
AGENT_PID=$!
disown "$AGENT_PID" 2>/dev/null || true
echo "$AGENT_PID" > "$PID_FILE"
echo "Started MacActivityAgent pid=$AGENT_PID"
echo "Logs: $LOG_OUT / $LOG_ERR"
echo "Stop: scripts/stop-all.sh  (or kill $AGENT_PID)"
echo "For auto-restart at login: scripts/install-launchagents.sh agent"
