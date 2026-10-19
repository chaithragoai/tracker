#!/usr/bin/env bash
# Installs user LaunchAgents with this project's absolute paths.
# macOS may ask you to allow background items in System Settings.
#
# Usage:
#   scripts/install-launchagents.sh           # all (server + agent + dailyreport)
#   scripts/install-launchagents.sh agent     # agent only (KeepAlive) — safest when server already runs
#   scripts/install-launchagents.sh server
#   scripts/install-launchagents.sh dailyreport
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents"
mkdir -p "$DEST"

SCOPE="${1:-all}"
case "$SCOPE" in
  all) NAMES=(com.macactivitytracker.server com.macactivitytracker.agent com.macactivitytracker.dailyreport) ;;
  agent) NAMES=(com.macactivitytracker.agent) ;;
  server) NAMES=(com.macactivitytracker.server) ;;
  dailyreport) NAMES=(com.macactivitytracker.dailyreport) ;;
  *)
    echo "Unknown scope: $SCOPE (use: all | agent | server | dailyreport)" >&2
    exit 2
    ;;
esac

if [[ "$SCOPE" == "all" || "$SCOPE" == "agent" ]]; then
  cd "$ROOT/mac-agent"
  swift build -c release --product MacActivityAgent
  BIN="$ROOT/mac-agent/.build/release/MacActivityAgent"
  sync
  # Ensure the Mach-O is readable before launchd exec (avoids rare dyld hang on a mid-write binary).
  if ! "$BIN" --help >/dev/null; then
    echo "ERROR: release agent binary failed --help after build" >&2
    exit 1
  fi
fi

# Avoid duplicate agents: stop a manually started binary before loading KeepAlive.
if [[ "$SCOPE" == "all" || "$SCOPE" == "agent" ]]; then
  if pgrep -f '/MacActivityAgent( |$)' >/dev/null 2>&1; then
    echo "Stopping existing MacActivityAgent so LaunchAgent can own it..."
    pkill -f '/MacActivityAgent( |$)' 2>/dev/null || true
    sleep 1
  fi
fi

UID_NUM="$(id -u)"
for name in "${NAMES[@]}"; do
  src="$ROOT/packaging/launchd/${name}.plist"
  out="$DEST/${name}.plist"
  sed "s|REPLACE_WITH_PROJECT_ROOT|$ROOT|g" "$src" > "$out"
  launchctl bootout "gui/${UID_NUM}/$name" 2>/dev/null || true
  launchctl unload "$out" 2>/dev/null || true
  sleep 1
  # Prefer modern bootstrap when available; fall back to load.
  if launchctl bootstrap "gui/${UID_NUM}" "$out" 2>/dev/null; then
    launchctl enable "gui/${UID_NUM}/$name" 2>/dev/null || true
    # Soft kickstart (no -k) so we do not race a brand-new binary mapping.
    launchctl kickstart "gui/${UID_NUM}/$name" 2>/dev/null || true
    echo "Bootstrapped $out"
  else
    launchctl load "$out"
    echo "Loaded $out"
  fi
done

echo ""
echo "If macOS blocks background items: System Settings → General → Login Items → allow Mac Activity Tracker entries."
echo "Logs: /tmp/macactivitytracker-*.log /tmp/macactivitytracker-*.err"
echo "Unload agent: launchctl bootout gui/\$(id -u)/com.macactivitytracker.agent"
echo "  (or: launchctl unload ~/Library/LaunchAgents/com.macactivitytracker.agent.plist)"
