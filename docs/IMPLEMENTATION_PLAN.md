# Personal AI Activity Assistant — Implementation Plan

Based on inspection of `/Users/chaithra/Desktop/tracker` on 2026-10-15.

## Already present (keep and reuse)

| Area | Status |
|------|--------|
| Swift mac-agent (NSWorkspace, idle, sleep/wake, gaps, pause) | Working |
| Node server on `127.0.0.1:8787` + SQLite | Working; **do not wipe DB** |
| Chrome MV3 extension (tabs, navigation, clicks, downloads) | **Live events confirmed** in DB (e.g. chatgpt.com, real UUID click events) |
| Analytics dashboard (donuts, rankings, date range, Chart.js) | Largely done |
| Privacy helpers, settings, CSV/HTML reports, backup | Present |
| Automated tests (events, analytics, reports, privacy) | Present |

## Gaps / risks found

1. **Website time overcounts** — background tabs keep open sessions until close/navigate (not active-tab-only).
2. **No extension health heartbeat** — hard to see if Chrome is still connected.
3. **Mac agent may be stopped** while server runs — status can look stale.
4. **Missing product features**: universal search, assistant chat, daily briefing UI, tasks, memories/projects, richer privacy page, screen/meeting capture.
5. **No FTS / projects / tasks tables** yet.
6. Screen Rewind & meeting audio need permissions investigation before any capture code.

## Phase order (this plan)

1. **Harden tracking** — active-tab timing, health/status, gap clarity (no DB wipe).
2. **Dashboard polish** — tracking health, active vs idle, context switches (build on existing UI).
3. **Universal search** — SQLite FTS over events + sessions + notes.
4. **Daily briefing** — deterministic summaries from real sessions.
5. **Deterministic assistant chat** — local Q&A over DB; cloud AI optional later.
6. **Tasks** — CRUD + AI suggestions requiring confirmation.
7. **Memories & projects** — curated notes separate from raw events.
8. **Privacy center + exports** — JSON/CSV, retention, toggles.
9. **Investigate** Screen Rewind & meetings — document blockers; no fake features.

## Safety rules

- Preserve `~/Library/Application Support/MacActivityTracker/tracker.sqlite`.
- Migrations are additive only (`CREATE TABLE IF NOT EXISTS`, new columns carefully).
- Distinctions: **recorded fact** vs **estimate** vs **AI suggestion**.
- No passwords/tokens/form values; cloud AI off by default.
