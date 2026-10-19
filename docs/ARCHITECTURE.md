# Architecture

## Goals

- Reliable frontmost-app tracking on macOS
- Browser tab + operation tracking via Chrome extension
- Local SQLite storage, dashboard, and reports
- Privacy by default (metadata only, pause, exclusions)

## Components

### `mac-agent` (Swift)

Uses `NSWorkspace` notifications:

- `didActivateApplicationNotification` — app became frontmost
- `didDeactivateApplicationNotification` — app lost focus
- `didLaunchApplicationNotification` / `didTerminateApplicationNotification`
- `willSleepNotification` / `didWakeNotification`

A light polling fallback (every 2s) catches rare missed notifications. Session logic lives in `ActivityCore` so it can be unit-tested without UI.

### `server` (Node.js)

- SQLite database (better-sqlite3)
- REST API for ingesting events from mac-agent and the extension
- Serves the dashboard
- Generates HTML/CSV reports

### `extension` (Chrome Manifest V3)

- Background service worker for tab lifecycle
- Content scripts only where needed for semantic operations
- Posts events to the local server

## Event contract (shared)

Every event has: `id`, `timestamp` (ISO-8601 UTC), `type`, optional `app` / `tab` refs, `metadata`, `outcome` (`success` | `failure` | `unknown`).

## Timestamps

Store UTC ISO-8601. Display in local time in the dashboard. Durations are computed from closed sessions only.

## Permissions (minimum)

| Component | Permission | Why |
|-----------|------------|-----|
| mac-agent | Accessibility (optional later) | Idle/input timing if needed beyond CGEventSource |
| Chrome ext | tabs, activeTab, storage, host permissions for allowed pages | Tab metadata + content hooks |
| server | Localhost only | No network egress by default |
