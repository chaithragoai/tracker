# Mac Activity Tracking Agent

Local-first app that records which Mac apps and Chrome tabs you use, how long you spend on them, and detectable in-page operations. Data stays on your computer.

## Inspection report (initial)

| Item | Finding |
|------|---------|
| Existing files | Folder was **empty** (greenfield) |
| What worked | Nothing yet |
| Broken / incomplete | N/A |
| Reusable components | None — built from scratch |

## What you get

| Piece | Role |
|-------|------|
| `mac-agent/` | Swift background tracker using **NSWorkspace** notifications (+ light poll fallback, idle via CoreGraphics) |
| `server/` | Local Node API + **SQLite** + dashboard + HTML/CSV reports |
| `extension/` | Chrome **Manifest V3** tab + operation tracker |
| `docs/` | Architecture, capability matrix, manual checklist, verification |

## Quick start (no coding required)

**1. Start the local server**

```bash
cd /Users/chaithra/Desktop/tracker/server
npm start
```

**2. Start the Mac app tracker** (must keep running — Chrome extension alone does not track Mac apps)

```bash
# Continuous (survives closing the Terminal that started it):
/Users/chaithra/Desktop/tracker/scripts/start-agent.sh

# Or interactive (stops when that Terminal exits / you type stop):
cd /Users/chaithra/Desktop/tracker/mac-agent && swift run MacActivityAgent
```

Do **not** use `--run-seconds` for normal use (that flag exits on purpose for automated tests).
Interactive commands: `status`, `pause`, `resume`, `stop`.

**3. Load the Chrome extension**

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → choose the `extension` folder

**4. Enroll this Mac (required for event ingest)**

```bash
# Server auto-provisions a local device on first start if none exist, or run:
scripts/enroll-local-device.sh
```

Then restart the Mac agent and, in the Chrome extension popup, click **Sync local device credentials**.  
See `docs/DEVICE_ENROLLMENT.md`.

**5. Open the dashboard**

[http://127.0.0.1:8787](http://127.0.0.1:8787)

Or use `scripts/start-all.sh` / `scripts/stop-all.sh`.

## Privacy (defaults)

- Metadata only (apps, URLs, event types) — not passwords, cookies, tokens, or payment fields
- Sensitive form values are never stored
- Pause from agent, extension popup, or dashboard settings
- Exclude apps/domains in the dashboard
- AI summaries **off** until you check consent + enable (still local-only; no cloud upload)

## Optional login startup (recommended for Mac agent reliability)

```bash
# Agent only — KeepAlive restarts if the process exits (safe when server already runs):
scripts/install-launchagents.sh agent

# Or all (server + agent + daily report):
scripts/install-launchagents.sh
```

If macOS asks: **System Settings → General → Login Items** → allow the tracker.

Scheduled daily report: LaunchAgent posts to `/api/reports/daily` at 18:00.

## Tests

```bash
cd mac-agent && swift run ActivityCoreTestRunner
scripts/verify-app-switch.sh
cd server && npm test
```

See `docs/FINAL_VERIFICATION.md` for executed results and `docs/MANUAL_ACCEPTANCE.md` for real-device checks.

## Data locations

- Database: `~/Library/Application Support/MacActivityTracker/tracker.sqlite`
- Agent JSONL: `~/Library/Application Support/MacActivityTracker/events.jsonl`
- Reports / backups: same folder under `reports/` and `backups/`
