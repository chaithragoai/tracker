#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Starting local server on http://127.0.0.1:8787 ..."
cd "$ROOT/server"
if ! curl -sf --connect-timeout 1 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  nohup node src/index.js >>/tmp/macactivitytracker-server.log 2>>/tmp/macactivitytracker-server.err &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true
  echo "$SERVER_PID" > /tmp/macactivitytracker-server.pid
  echo "Server PID $SERVER_PID"
else
  echo "Server already responding on :8787 — leaving it alone"
fi

echo "Starting mac-agent (continuous; no time limit)..."
"$ROOT/scripts/start-agent.sh"

echo ""
echo "Dashboard: http://127.0.0.1:8787"
echo "Load Chrome extension from: $ROOT/extension"
echo "Optional login KeepAlive: $ROOT/scripts/install-launchagents.sh agent"
echo "Stop with: scripts/stop-all.sh"
