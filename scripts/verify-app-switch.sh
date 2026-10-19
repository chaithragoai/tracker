#!/usr/bin/env bash
# Live acceptance: activate 3 macOS apps and confirm the agent recorded switches.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/MacActivityTracker"
EVENTS="$SUPPORT/events.jsonl"
MARKER="$SUPPORT/verify-marker.txt"
AGENT_BIN="$ROOT/mac-agent/.build/debug/MacActivityAgent"

mkdir -p "$SUPPORT"
touch "$EVENTS"
cd "$ROOT/mac-agent"
swift build --product MacActivityAgent

# Marker so we only inspect events from this run
date -u +"VERIFY_START %Y-%m-%dT%H:%M:%SZ" > "$MARKER"
START_LINE=$(wc -l < "$EVENTS" | tr -d ' ')

# Launch agent for a fixed window
"$AGENT_BIN" --no-http --run-seconds 25 --quiet &
AGENT_PID=$!
sleep 2

activate_app() {
  local name="$1"
  osascript -e "tell application \"$name\" to activate" >/dev/null 2>&1 || true
  sleep 2
}

echo "Activating Finder..."
activate_app "Finder"

echo "Activating TextEdit..."
# Ensure TextEdit is available
open -a TextEdit >/dev/null 2>&1 || true
sleep 1
activate_app "TextEdit"

echo "Activating Calculator..."
open -a Calculator >/dev/null 2>&1 || true
sleep 1
activate_app "Calculator"

echo "Returning to Finder..."
activate_app "Finder"

wait "$AGENT_PID" || true

# Slice new events
NEW_EVENTS=$(tail -n +"$((START_LINE + 1))" "$EVENTS" 2>/dev/null || true)
echo "---- New events (tail) ----"
echo "$NEW_EVENTS" | tail -n 40

check_app() {
  local bundle="$1"
  local label="$2"
  if echo "$NEW_EVENTS" | grep -q "\"bundleIdentifier\":\"$bundle\""; then
    echo "PASS: detected $label ($bundle)"
    return 0
  fi
  # Fallback: name match
  if echo "$NEW_EVENTS" | grep -qi "\"name\":\"$label\""; then
    echo "PASS: detected $label by name"
    return 0
  fi
  echo "FAIL: did not detect $label"
  return 1
}

FAIL=0
check_app "com.apple.finder" "Finder" || FAIL=1
check_app "com.apple.TextEdit" "TextEdit" || FAIL=1
check_app "com.apple.calculator" "Calculator" || FAIL=1

# Require at least 2 sessionStarted events (switches happened)
STARTED=$(echo "$NEW_EVENTS" | grep -c '"type":"sessionStarted"' || true)
if [[ "$STARTED" -ge 3 ]]; then
  echo "PASS: sessionStarted count=$STARTED (>=3)"
else
  echo "FAIL: sessionStarted count=$STARTED (expected >=3)"
  FAIL=1
fi

# Ensure trackerStarted present
if echo "$NEW_EVENTS" | grep -q '"type":"trackerStarted"'; then
  echo "PASS: trackerStarted recorded"
else
  echo "FAIL: trackerStarted missing"
  FAIL=1
fi

if [[ "$FAIL" -eq 0 ]]; then
  echo "VERIFY_APP_SWITCH: ALL PASSED"
  exit 0
fi
echo "VERIFY_APP_SWITCH: FAILED"
exit 1
