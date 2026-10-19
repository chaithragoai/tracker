# Milestone 2 results

**Status:** Complete and verified

## Built

- SQLite schema: events, app_sessions, tab_sessions, idle_periods, tracking_gaps, daily_summaries, tracker_status
- Local Node server on `127.0.0.1:8787` with event ingest + query APIs
- Duplicate prevention via `INSERT OR IGNORE` on event IDs
- Idle detection in mac-agent via CoreGraphics last-input API (60s threshold)
- Restart gaps marked as `gapDetected` (no invented activity)
- CSV export endpoint `/api/export/csv`

## Tests executed

```
cd server && npm test
→ 6/6 passed

cd mac-agent && swift run ActivityCoreTestRunner
→ ALL PASSED (10 tests) including idleStartAndEnd

swift build --product MacActivityAgent
→ Build complete
```

## Database location

`~/Library/Application Support/MacActivityTracker/tracker.sqlite`
