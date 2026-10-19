# Multi-Device Manager Dashboard — Implementation Plan

**Phase:** 1 (inspection only)  
**Date:** 2026-10-15  
**Repo:** `/Users/chaithra/Desktop/tracker`  
**Status:** Plan only — **no application code changes in Phase 1**  
**Related prior doc:** `docs/MULTI_DEVICE_PLATFORM_PLAN.md` (high-level platform sketch; this document is the actionable plan aligned to Phases 2–5)

---

## 1. Inspection findings (current system)

### 1.1 Frontend dashboard structure and navigation

| Item | Finding |
|------|---------|
| Entry | `server/public/index.html` + `server/public/app.js` + `server/public/styles.css` |
| Architecture | Single-page app; views toggled via `.nav-item[data-view=…]` — **no per-tab URLs** |
| Brand | “Activity Assistant” (`.brand-name`) |
| Existing tabs (11) | Overview, App Usage, Browser Activity, Timeline, Search, Assistant, Daily Briefing, Tasks, Memories, Activity History, Reports & Privacy |
| Data | Fetches real APIs (`/api/analytics`, `/api/events`, `/api/tracking/health`, tasks, memories, etc.) — charts via Chart.js vendor copy |
| Manager / devices UI | **None** |

**Preserve rule:** Add a **12th** nav item / view (e. of Manager) without removing or redesigning the existing 11.

### 1.2 Backend API routes and authentication

Server: Node `http` module in `server/src/http.js`, started by `server/src/index.js`.

| Fact | Detail |
|------|--------|
| Bind address | **`127.0.0.1` only** (not `0.0.0.0`) — localhost personal use |
| Default port | `8787` (`PORT` env override) |
| Auth | **None** — no sessions, JWT, API keys, or roles |
| CORS | `Access-Control-Allow-Origin: *` with `Content-Type` only |
| Ingest | `POST /api/events` accepts any JSON event(s); source guessed if omitted |
| Health | `GET /api/health`, `GET /api/tracking/health`, `GET /api/status` |
| Analytics / export | `/api/analytics`, sessions, idle, gaps, CSV/JSON export |
| Assistant stack | search, briefing, assistant, tasks, memories, projects, settings, backup |

**Implication:** Anything “central” must add authenticated routes; local mode must keep unauthenticated localhost ingest for current agent/extension.

### 1.3 SQLite schema and migrations

| Item | Finding |
|------|---------|
| Path | `~/Library/Application Support/MacActivityTracker/tracker.sqlite` (override `TRACKER_DB`) |
| Schema | `server/src/db/schema.sql` + additive `migrate()` in `server/src/db/database.js` |
| Versioning | `schema_migrations` — currently **v1** base schema, **v2** health columns + projects/tasks/memories/FTS |
| Core tables | `events`, `app_sessions`, `tab_sessions`, `idle_periods`, `tracking_gaps`, `daily_summaries`, `tracker_status` (singleton `id=1`) |
| Device tables | **None** — no `devices`, credentials, orgs, employees, audit |
| `events` identity | Primary key = client-supplied `id`; **no `device_id` column** |

Migrations are already additive (`ALTER TABLE … ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`). Multi-device work must continue that pattern — **never wipe DB**.

### 1.4 How Mac agent events reach the backend

```
NSWorkspace / IdleMonitor
  → SessionManager (ActivityCore)
  → MultiplexSink: JSONL file + HTTPEventSink
  → POST http://127.0.0.1:8787/api/events
  → insertEvent() → events + app_sessions + tracker_status
```

| Item | Finding |
|------|---------|
| Binary | Swift `MacActivityAgent` (`mac-agent/`) |
| HTTP | `HTTPEventSink` posts JSON; failures logged to stderr; **no durable retry queue to server** |
| Local backup | `~/Library/…/events.jsonl` + `agent-state.json` |
| CLI | `--server URL`, `--quiet`, `--no-http`, `--run-seconds N` (test-only exit) |
| Startup | Manual Terminal / `scripts/start-agent.sh` / LaunchAgent `com.macactivitytracker.agent` (`KeepAlive`) |
| Device auth | **None** — trusts open localhost |

### 1.5 How Chrome extension events reach the backend

```
tabs / webNavigation / content ops / 1-min heartbeat alarm
  → postEvent() in extension/background.js
  → POST http://127.0.0.1:8787/api/events  (source: chrome-extension)
  → insertEvent() → events + tab_sessions + tracker_status
```

| Item | Finding |
|------|---------|
| Server URL | Hardcoded `http://127.0.0.1:8787` |
| Offline | Events **dropped** if fetch fails (“queue can be added later”) |
| Heartbeat | `extensionHeartbeat` every ~1 minute → drives `extension_connected` |
| Privacy | Domain/URL/title metadata; protected URLs / exclusions; no passwords/cookies |
| Device auth | **None** |

### 1.6 How devices are currently identified

**They are not.**

- Single shared `tracker_status` row (`id = 1`) for the whole machine.  
- Events distinguished only by `source` (`mac-agent` / `chrome-extension`) and payload fields.  
- No hostname, hardware UUID, enrollment ID, or employee assignment in the DB.  
- Hostname is not attached on ingest today.

### 1.7 How agent and extension health are calculated

Implemented in `getTrackingHealth()` (`server/src/services/events.js`):

| Signal | Meaning today |
|--------|----------------|
| `status` | From agent lifecycle events (`trackerStarted` / `Paused` / `Stopped`, etc.) on the singleton row |
| `last_mac_event_at` | Last event classified as Mac/agent-related |
| `last_chrome_event_at` / `extension_last_seen_at` | Last Chrome-classified event / heartbeat |
| `extension_connected` | **True iff** extension last seen **&lt; 180 seconds** ago |
| `mac_event_age_seconds` | Age of last Mac event — **grows while user stays on one app without switches** |

**Critical for Manager status design:**

- Idle user ≠ offline agent. Do not mark offline solely because `mac_event_age` is large.  
- Backend reachable ≠ agent healthy. Need **device check-in / heartbeat** separate from app-switch events.  
- Singleton health cannot represent multiple machines.

### 1.8 Playwright tests and commands

| Suite | Command | Scope |
|-------|---------|-------|
| Dashboard smoke | `cd e2e && npm test` (or `npx playwright test`) | **25 tests**, Chromium, `baseURL` `http://127.0.0.1:8787` |
| Server unit | `cd server && npm test` | events, reports, analytics, migration-health, assistant, extension privacy |
| Agent core | `cd mac-agent && swift run ActivityCoreTestRunner` | SessionManager logic |
| App switch script | `scripts/verify-app-switch.sh` | Live short agent window (`--run-seconds`) |

Smoke suite enumerates the **exact 11 tabs**; adding a Manager tab requires **additive** smoke coverage, not replacing the 25.

### 1.9 Startup scripts and LaunchAgent

| Script / plist | Role |
|----------------|------|
| `scripts/start-agent.sh` | Continuous agent via `nohup` (no `--run-seconds`) |
| `scripts/start-all.sh` | Server if needed + `start-agent.sh` |
| `scripts/stop-all.sh` | Unloads agent LaunchAgent if present, then kills PIDs |
| `scripts/install-launchagents.sh [agent\|server\|all]` | User LaunchAgents; agent uses release binary + `KeepAlive` |
| `packaging/launchd/com.macactivitytracker.agent.plist` | `--quiet`, `RunAtLoad`, `KeepAlive` |
| Server / dailyreport plists | Optional; server still typically `npm start` in local dev |

---

## 2. What can be reused

| Asset | Reuse how |
|-------|-----------|
| Event contract (`id`, `timestamp`, `type`, `app`/`tab`, `metadata`, `outcome`, `source`) | Keep; add server-assigned `device_id` after auth |
| `insertEvent` / session projection / analytics math | Scope queries by `device_id` in central mode |
| Local SQLite + WAL + additive migrations | Local mode remains default; central may later use Postgres |
| Existing 11-tab dashboard | Untouched personal “this device” experience |
| Privacy rules (no keystrokes/passwords/screenshots) | Carry into multi-device policy |
| LaunchAgent KeepAlive pattern | Per-device agent reliability on each Mac |
| Playwright smoke pattern | Keep 25 green; add separate manager/device tests |
| Health age math | Reuse thresholds, but **per device** + separate check-in vs activity |

---

## 3. What needs to be added (by later phases)

### Phase 2 — Device identity and enrollment (next implementation slice)

- Tables: `devices`, `device_credentials` (hash only), `enrollment_tokens`, optional `employees` / assignment  
- Additive columns: `events.device_id`, `app_sessions.device_id`, `tab_sessions.device_id` (nullable for legacy local rows)  
- APIs: create enrollment token, redeem → device + one-time secret, revoke, rotate, check-in  
- Authenticated ingest: e.g. `Authorization: Device <device_id> <token>` — **never trust body `device_id`**  
- Local mode: auto single “local” device **or** continue null `device_id` with open localhost ingest  
- Agent/extension: optional credential file / storage; still default to localhost unauthenticated when `TRACKER_MODE=local`

### Phase 3 — Manager Dashboard

- New nav view **Manager** (12th tab) — list + detail from real enrolled data  
- Status model with explicit thresholds (see §6)  
- Search, filters, sort, refresh, loading/empty/error states  
- Detail: permitted app/site names, durations, timestamps for selected device/period  

### Phase 4 — Central backend readiness (docs + controls before rollout)

- Hosting on company private network / approved infra (not public exposure of laptop `:8787`)  
- TLS, manager login + RBAC, rate limits, audit log, backups, credential rotation  
- `TRACKER_MODE=central` config; local remains usable  

### Phase 5 — Testing

- Automated enrollment/auth/spoofing/status/migration tests  
- Two real enrolled systems for true multi-device E2E — else mark **BLOCKED**  
- Re-run original **25** Playwright smokes — must stay green  

---

## 4. Preserving local development

```
TRACKER_MODE=local   (default)
  - Bind 127.0.0.1
  - POST /api/events without device auth (current behavior)
  - Existing dashboard tabs behave as today
  - Existing SQLite rows kept; new columns NULL for legacy events
  - Agent/extension keep hardcoded or config localhost URL

TRACKER_MODE=central (later, opt-in)
  - Device auth required on ingest
  - Manager auth required on manager APIs
  - Still not “open to the public internet” without company TLS reverse proxy
```

- Do not reset `tracker.sqlite`.  
- Do not change LaunchAgent paths unless necessary for config file location.  
- Dual-write risk: avoid requiring central server for personal laptop use.

---

## 5. How a central server will receive events from multiple systems

```
[Mac N] mac-agent ──┐
                    ├── TLS ──► Company reverse proxy ──► Central Tracker API
[Mac N] Chrome ext ─┘              (private network)         │
                                                             ▼
                                              devices + events (scoped)
                                                             │
                                              Manager UI (RBAC)
```

Per device:

1. Admin issues **enrollment token** (TTL, single-use or limited).  
2. Device redeems → receives `device_id` + **secret shown once**; server stores **hash** only.  
3. Agent + extension store credentials in user-local config (Keychain preferred later; file with locked perms acceptable v1).  
4. Every ingest: authenticate credential → server sets `device_id` from auth context.  
5. Periodic **check-in** heartbeat (agent + extension) updates `last_check_in_at` independently of app switches.  
6. Revocation invalidates credential hash / status → subsequent ingest **401/403**.

**Out of scope for Phase 2–3:** exposing home laptop to the internet, NAT hole-punching, or “fake” multi-device rows.

---

## 6. Device identities and employee assignments

| Field | Purpose |
|-------|---------|
| `device_id` | Server-generated UUID; persistent; primary key |
| `display_name` | Human label (e.g. “Chaithra’s MacBook”) |
| `os` / `os_version` / `agent_version` | Inventory |
| `enrollment_status` | `pending` \| `active` \| `revoked` |
| `employee_id` / display name | Optional assignment; nullable |
| `last_check_in_at` | Auth’d heartbeat — **online signal** |
| `last_mac_event_at` / `last_chrome_event_at` | Activity signals (may lag while idle) |
| Credential | Random secret; **bcrypt/argon2/scrypt hash** at rest; rotatable |

**Rule:** Client may send a claimed device id for debugging, but the server **ignores** it for attribution and uses only the authenticated device.

### Proposed Manager status thresholds (Phase 3)

| Status | Definition (draft — tune in implementation) |
|--------|-----------------------------------------------|
| Online + active | Check-in &lt; 5 min **and** (Mac or Chrome activity &lt; 15 min) |
| Online + idle | Check-in &lt; 5 min **and** no app/site activity recently — **not offline** |
| Stale check-in | Check-in 5–30 min old |
| Offline / unreachable | Check-in missing or &gt; 30 min |
| Agent problem | Check-in OK but agent reports paused/error, or Mac channel silent while Chrome check-in continues for long window (configurable) |
| Extension problem | Agent check-in OK but extension heartbeat stale (&gt; 3–5 min) while enrolled with Chrome |
| Needs attention | Revocation pending, enrollment incomplete, repeated auth failures, or version far behind |
| Unknown | Insufficient check-in history |

---

## 7. Security controls required

| Control | Requirement |
|---------|-------------|
| Transport | HTTPS on central deploy; local may stay HTTP on loopback |
| Device auth | Per-device revocable secrets; hash at rest; rotate |
| Manager auth | Session or SSO; roles `admin` / `manager` / (optional) `employee` |
| Authorization | Managers see only assigned org/team devices |
| Ingest validation | Schema validation, size limits, rate limits |
| Spoofing prevention | Event `device_id` always from auth context |
| Audit | Enrollment, revoke, rotate, manager exports/views of sensitive data |
| Least data | App/site names, durations, timestamps, health metadata only |
| Revocation | Immediate ingest denial; UI shows revoked |
| No public laptop bind | Keep `127.0.0.1` in local mode; central only on approved infra |

---

## 8. Testing without overwriting existing data

| Practice | Detail |
|----------|--------|
| Migrations | Additive only; test against copy of DB via `TRACKER_DB=/tmp/tracker-test.sqlite` |
| Unit tests | Already use isolated temp DBs in `server/test/*` — extend same pattern |
| Smoke | Hit live local DB read-only for UI; do not DELETE FROM events |
| Dual-device | Prefer second machine or second enrolled credential against a **separate test DB / staging central** — never wipe personal `tracker.sqlite` |
| Simulation | Allowed in unit tests if labeled; **real two-device E2E** marked BLOCKED until second system exists |
| Regression | Always re-run `cd e2e && npx playwright test` → **25/25** |

---

## 9. Implementation order (gates)

| Gate | Deliverable | Code allowed? |
|------|-------------|---------------|
| **Phase 1 (this doc)** | Inspection + plan | Docs / reports only |
| **Phase 2** | Enrollment + device-auth ingest + migrations | Yes, after plan review |
| **Phase 3** | Manager Dashboard UI | After Phase 2 works |
| **Phase 4** | Central readiness docs + security hardening checklist | Docs + minimal hooks |
| **Phase 5** | Automated + dual-device tests + smoke 25 | After Phase 3 |

**Explicit non-claims until Phase 5 dual-device PASS:** “multi-device works in production,” “all company Macs visible,” “central cloud ready.”

---

## 10. Risks and open decisions (need stakeholder input later)

1. Where will the **central** host live (VPN-only VM, internal k8s, etc.)?  
2. Manager identity provider (local passwords vs company SSO/MFA)?  
3. Is Chrome extension enrollment the same credential as the Mac agent, or separate? (**Recommendation:** one device credential shared by agent + extension on that machine.)  
4. Employee self-view of their own device data?  
5. Retention period for events on central server?  
6. Availability of a **second physical Mac** for acceptance?

---

## 11. Phase 1 conclusion

The product is a **solid single-machine local tracker** with verified Mac + Chrome ingest and a reliable LaunchAgent path. It has **no device identity, no auth, and no multi-tenant schema**. Building a Manager Dashboard on fake devices would violate project rules; Phase 2 must create real enrollment and authenticated attribution first, while **`TRACKER_MODE=local` keeps today’s laptop workflow and data intact**.

**Next step:** Review this plan. On approval, implement **Phase 2 only** (device identity + enrollment + authenticated ingest + safe migrations).
