# Centralized Multi-Device Platform — Implementation Plan

**Date:** 2026-10-15  
**Based on:** live inspection of `/Users/chaithra/Desktop/tracker`  
**Constraint:** Preserve existing SQLite data and local single-device mode. No destructive rewrite.

---

## 1. What exists today (facts)

| Component | Reality |
|-----------|---------|
| Swift mac-agent | Records app sessions, idle, sleep/wake, gaps; posts to localhost |
| Chrome MV3 extension | Live events **are** reaching the server (`extension_connected: true`, recent chrome events) |
| Node server | Bound to `127.0.0.1:8787` only — single machine |
| Database | Local SQLite (`tracker.sqlite`) — events, sessions, tasks, memories, FTS |
| Dashboard | Single-user analytics, search, assistant, briefing, tasks, privacy |
| Auth / orgs / devices | **None** — no login, no enrollment, no multi-tenant isolation |
| Central cloud DB | **None** |
| Offline event queue with retry | **Partial** — extension drops if server down; agent has JSONL but not a durable sync queue |

**Live health snapshot (at plan time):** server OK; Chrome heartbeat connected; Mac last event older than Chrome (agent may not be continuously running).

---

## 2. Gap vs company platform goal

The product today is a **personal local assistant**.  
The goal is a **company-authorized multi-device monitoring platform**.

Missing foundations (must come before “manager sees all devices”):

1. Organizations, teams, employees, roles  
2. Device enrollment + revocable credentials (no shared API key)  
3. Central backend mode (Postgres or similar) beside local SQLite  
4. AuthN/AuthZ on every protected API  
5. Multi-device inventory + scoped analytics  
6. Health alerts, audit logs, retention policy  
7. HTTPS deployment and secret management  

Screen/audio capture remain **out of scope** unless separately approved (already documented in `SCREEN_AND_MEETINGS.md`).

---

## 3. Architecture principle (non-destructive)

```
KEEP:  mac-agent + Chrome extension + local SQLite mode + current dashboard routes
ADD:   “central mode” behind config flags
ADD:   org/device/auth tables (additive migrations)
ADD:   manager/admin UI views that only work when authenticated
```

- `TRACKER_MODE=local` → current behavior (default).  
- `TRACKER_MODE=central` → multi-tenant DB + auth + enrollment.  
- Agents get `server_url` + `device_credentials` in a local config file (never hardcoded).

---

## 4. Phased plan (implement in this order)

### Phase A — Verify & harden single-device ingestion (reuse current stack)
**Goal:** Prove real Mac + Chrome events still flow; improve integrity.

- Confirm agent + extension → `/api/events` with live browsing/app switches.  
- Add durable **local outbox** (SQLite or JSONL queue) with exponential backoff.  
- Attach `agent_version`, machine hostname, and a **local provisional device UUID** (not trusted as identity in central mode).  
- Keep pause/resume, exclusions, gap detection.  
- Tests: duplicate IDs, offline buffer flush, health endpoint.

**Exit criteria:** Real events observed; automated integrity tests green; local DB untouched except additive columns.

### Phase B — Identity model (schema only first, then APIs)
**Goal:** Data model for company use without breaking local mode.

Additive tables (examples):

- `organizations`, `teams`, `users`, `memberships`, `roles`  
- `devices`, `device_credentials`, `enrollment_tokens`  
- `events` / sessions gain nullable `device_id`, `org_id`  
- `audit_logs`, `alerts`

Local mode continues writing with `device_id = null` or a single “local” device.

### Phase C — Enrollment & device auth
**Goal:** No shared API key; revocable per-device credentials.

- Admin creates enrollment token (TTL, one-time or limited use).  
- Agent redeems token → receives `device_id` + secret (hashed server-side).  
- Every ingest request: `Authorization: Device <id>:<signature-or-token>`.  
- Server binds events to authenticated device (ignore client-supplied org/employee).  
- Revoke/re-enroll flows; agent version + last_seen.

**Exit criteria:** Two simulated devices cannot impersonate each other; revocation stops ingest.

### Phase D — Central backend mode
**Goal:** Production-shaped server without deleting SQLite path.

- Postgres (recommended) via `DATABASE_URL`; SQLite remains default for laptop.  
- HTTPS termination (reverse proxy / platform TLS).  
- Rate limits, payload size limits, pagination.  
- Secrets only in env / secret manager.  
- Deployment guide for company infra.

### Phase E — Manager dashboard (multi-device)
**Goal:** Inventory + device detail from real enrolled data.

- Org overview: device counts, online/stale, errors, version mix.  
- Device list + detail (reuse analytics services scoped by `device_id`).  
- RBAC: manager sees assigned team only.

### Phase F — Team analytics & reports
**Goal:** Filters by org/team/employee/device/date; separate app vs web time.

- Reuse `analytics.js` with multi-device queries.  
- CSV/HTML exports with scope checks.

### Phase G — Health alerts
**Goal:** Stale sync, extension quiet, outdated agent, queue growth — with dedupe.

### Phase H — Privacy, governance, audit
**Goal:** Policy notice, retention, employee self-view, audit of admin actions.

### Phase I — Optional AI assistant (scoped)
**Goal:** Same deterministic retrieval style as today, but **permission-filtered** before answer.

### Phase J — Ops admin
**Goal:** Enrollment UI, version report, config push (narrow, audited — **no remote shell**).

---

## 5. What we will NOT do in early phases

- Covert monitoring, hidden agents, TCC/permission bypasses  
- Shared hardcoded API keys across devices  
- Unauthenticated internet-facing dashboard  
- Deleting or recreating `tracker.sqlite`  
- Fake multi-device charts  
- Screen/audio capture  
- Arbitrary remote command execution on employee Macs  

---

## 6. Testing strategy

| Level | Approach |
|-------|----------|
| Automated | Enrollment, authz isolation, ingest, duplicates, alerts, analytics math |
| Simulated devices | Two device credentials in tests (clearly labeled simulated) |
| Real acceptance | This Mac + Chrome (device 1); second company Mac when available (device 2) |

Simulated ≠ real. Final report will separate them.

---

## 7. Recommended first build slice (after you approve this plan)

1. Phase A outbox + agent/device metadata fields (local-safe).  
2. Phase B/C enrollment tables + device-authenticated `/api/v1/devices/.../events`.  
3. Keep `/api/events` for local unauthenticated mode behind `TRACKER_MODE=local`.  
4. Minimal “Devices” page that lists enrolled devices (empty until enrollment).  

Estimated risk to current personal use: **low**, if local mode remains default.

---

## 8. Permissions / company prerequisites (you must supply later)

- Written employee monitoring notice / legal approval  
- Where the central server will be hosted (domain, TLS certs)  
- Who are the first admin users  
- Whether MFA provider (e.g. company IdP) is required for managers  
- Second physical Mac for real dual-device acceptance  

---

## 9. Approval gate

**No destructive implementation of central multi-tenant mode has been started.**  
Awaiting your go-ahead to begin **Phase A** (harden single-device + outbox) while keeping local mode as default.
