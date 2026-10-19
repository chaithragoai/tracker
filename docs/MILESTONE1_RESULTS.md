# Milestone 1 results

**Date:** 2026-10-15  
**Status:** Complete and verified

## Inspection

- Project folder was empty (greenfield).
- Stack chosen: Swift `mac-agent` (NSWorkspace) + Node server (later) + Chrome MV3 (later).
- Full Xcode is not installed — only Command Line Tools — so tests use `ActivityCoreTestRunner` instead of XCTest.

## What was built

- `ActivityCore` — pure session engine (switches, pause, exclusions, sleep/wake, gaps)
- `MacActivityAgent` — NSWorkspace notifications + 2s poll fallback, JSONL sink, status/pause/resume/stop
- Live verifier: `scripts/verify-app-switch.sh`

## Automated tests (executed)

```
swift run ActivityCoreTestRunner
→ ActivityCoreTestRunner: ALL PASSED (9 tests)
```

Covered: 3-app switches, non-overlapping intervals, duplicates, pause/resume, exclusions, sleep/wake, gaps, duration totals, JSON encoding.

## Live macOS verification (executed)

```
scripts/verify-app-switch.sh
→ VERIFY_APP_SWITCH: ALL PASSED
```

Detected real switches among **Finder**, **TextEdit**, and **Calculator** with bundle IDs and durations.

## Permissions note

`NSWorkspace` frontmost-app detection worked without Accessibility permission for this milestone. Idle detection (Milestone 2) may use `CGEventSource` seconds-since-last-input, which also typically does not require Accessibility for the idle timer API.
