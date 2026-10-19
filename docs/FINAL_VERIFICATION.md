# Final verification report

**Date:** 2026-10-15  
**Project:** Mac Activity Tracking Agent  

## Milestone status

| Milestone | Status | Evidence |
|-----------|--------|----------|
| 1 macOS app detection | Pass | Live `verify-app-switch.sh` detected Finder, TextEdit, Calculator |
| 2 SQLite / idle / recovery | Pass | 6 DB/HTTP tests + idle unit test |
| 3 Chrome tab tracking | Pass | Extension + tab session DB test + smoke ingest |
| 4 Browser operations + matrix | Pass | click/search/form heuristics + `CAPABILITY_MATRIX.md` |
| 5 Dashboard + reports | Pass | Dashboard UI + HTML/CSV report tests + smoke report file |
| 6 Background / privacy / AI | Pass | LaunchAgent plists, settings API, AI off-by-default |
| 7 Regression | Pass | Combined automated suite below |

## Automated tests actually executed

### ActivityCore (Swift)

```
cd mac-agent && swift run ActivityCoreTestRunner
→ ActivityCoreTestRunner: ALL PASSED (10 tests)
```

### Live app switching

```
scripts/verify-app-switch.sh
→ VERIFY_APP_SWITCH: ALL PASSED
  PASS Finder, TextEdit, Calculator; sessionStarted ≥ 3
```

### Server + extension privacy

```
cd server && npm test
→ 13/13 passed (events, idle, gaps, CSV, HTTP, reports, AI gate, tabs, privacy)
```

### Integration smoke (executed)

- Server health `{"ok":true}`
- Extension-shaped tab + click ingested
- mac-agent ran ~4s and reported frontmost app
- Daily HTML report written under Application Support
- AI summary returned `enabled: false` without consent
- SQLite backup created successfully

## Known limitations

1. Full Xcode is not installed — XCTest unavailable; use `ActivityCoreTestRunner`.
2. Chrome extension tab tracking requires manual “Load unpacked” once (browser security).
3. Not every website operation is capturable; see capability matrix.
4. Login Agents need your approval in System Settings → Login Items.
5. AI summaries are local digests only; external AI is never called.

## How to run day-to-day

```bash
# Terminal A
cd server && npm start

# Terminal B
cd mac-agent && swift run MacActivityAgent

# Chrome → chrome://extensions → Load unpacked → extension/
# Dashboard → http://127.0.0.1:8787
```

Optional auto-start: `scripts/install-launchagents.sh`
