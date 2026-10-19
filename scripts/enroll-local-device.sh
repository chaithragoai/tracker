#!/usr/bin/env bash
# Explicit local enrollment: creates an enrollment token, redeems it, writes credentials.
# Requires the tracker server running on 127.0.0.1:8787 (TRACKER_MODE=local).
set -euo pipefail

SERVER="${TRACKER_SERVER:-http://127.0.0.1:8787}"
SUPPORT="${TRACKER_SUPPORT_DIR:-$HOME/Library/Application Support/MacActivityTracker}"
CREDS="$SUPPORT/device-credentials.json"
DISPLAY_NAME="${TRACKER_DEVICE_NAME:-$(hostname -s 2>/dev/null || echo Local-Mac) (local)}"
TMPDIR_ENROLL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ENROLL"' EXIT

echo "Checking server at $SERVER ..."
curl -sf "$SERVER/api/health" >/dev/null || {
  echo "ERROR: server not reachable. Start with: cd server && npm start" >&2
  exit 1
}

CURL_ADMIN=(curl -sf -X POST "$SERVER/api/admin/enrollment-tokens" -H 'Content-Type: application/json')
if [[ -n "${TRACKER_ADMIN_TOKEN:-}" ]]; then
  CURL_ADMIN+=(-H "X-Tracker-Admin-Token: $TRACKER_ADMIN_TOKEN")
fi

echo "Creating enrollment token ..."
"${CURL_ADMIN[@]}" \
  -d "{\"display_name_hint\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$DISPLAY_NAME"),\"ttl_seconds\":600,\"max_uses\":1}" \
  >"$TMPDIR_ENROLL/token.json"

ENROLL_TOKEN=$(python3 -c 'import json; print(json.load(open("'"$TMPDIR_ENROLL"'/token.json"))["enrollment_token"])')

python3 -c 'import json,sys; json.dump({"enrollment_token":sys.argv[1],"display_name":sys.argv[2],"os":"macOS","agent_version":"enroll-local-device.sh"}, open(sys.argv[3],"w"))' \
  "$ENROLL_TOKEN" "$DISPLAY_NAME" "$TMPDIR_ENROLL/enroll-body.json"

echo "Redeeming enrollment token ..."
curl -sf -X POST "$SERVER/api/devices/enroll" \
  -H 'Content-Type: application/json' \
  --data-binary @"$TMPDIR_ENROLL/enroll-body.json" \
  >"$TMPDIR_ENROLL/enrolled.json"

mkdir -p "$SUPPORT"
python3 - <<PY
import json, os
from pathlib import Path
enroll = json.load(open("$TMPDIR_ENROLL/enrolled.json"))
payload = {
  "device_id": enroll["device_id"],
  "device_secret": enroll["device_secret"],
  "display_name": enroll.get("display_name") or "$DISPLAY_NAME",
  "server_url": "$SERVER",
  "created_at": enroll.get("created_at"),
  "note": "Local device credentials. Do not commit or share.",
}
path = Path("$CREDS")
path.write_text(json.dumps(payload, indent=2))
os.chmod(path, 0o600)
print(f"Wrote {path}")
print(f"device_id={payload['device_id']}")
PY

echo ""
echo "Done. Restart MacActivityAgent so it reloads credentials."
echo "Chrome extension: open the popup → Sync local device credentials."
echo "Do not commit $CREDS"
