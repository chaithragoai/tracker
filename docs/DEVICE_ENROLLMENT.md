# Device enrollment (Phase 2)

Every Mac that sends events must be **enrolled** and authenticate with a **device credential**.  
Unauthenticated `POST /api/events` is rejected. Legacy events in SQLite keep `device_id = NULL` (no invented history).

## Local development (this laptop)

1. Start the server (binds `127.0.0.1:8787` only):

   ```bash
   cd server && npm start
   ```

   On first start in `TRACKER_MODE=local` (default), if no active devices exist, the server **auto-provisions** one local device and writes:

   `~/Library/Application Support/MacActivityTracker/device-credentials.json` (mode `0600`)

2. Or enroll explicitly (also works to add another device later):

   ```bash
   scripts/enroll-local-device.sh
   ```

3. Restart the Mac agent so it reloads credentials:

   ```bash
   # if using LaunchAgent:
   launchctl kickstart -k gui/$(id -u)/com.macactivitytracker.agent
   # or:
   scripts/start-agent.sh
   ```

4. Chrome extension: open the popup → **Sync local device credentials**  
   (loads `/api/local/device-config` from localhost into `chrome.storage.local`)

### Auth header

```
Authorization: Device <device_id> <device_secret>
```

The server **ignores** any `device_id` in the JSON body and attributes events to the authenticated device only.

## Admin APIs (local mode or `X-Tracker-Admin-Token`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/admin/enrollment-tokens` | Create one-time (or limited) enrollment token |
| POST | `/api/devices/enroll` | Redeem token → `device_id` + `device_secret` (shown once) |
| POST | `/api/admin/devices/:id/revoke` | Revoke device; further ingest returns 403 |
| GET | `/api/admin/devices` | List devices (no secrets) |
| POST | `/api/devices/check-in` | Authenticated heartbeat |
| GET | `/api/local/device-config` | Local-only credential bootstrap (`TRACKER_MODE=local`) |

In **central** mode, set `TRACKER_ADMIN_TOKEN` and send `X-Tracker-Admin-Token` for admin routes.  
Do not rely on local auto-provision in central mode (`TRACKER_LOCAL_AUTO_PROVISION=0` recommended).

## Revocation

```bash
curl -X POST http://127.0.0.1:8787/api/admin/devices/<DEVICE_ID>/revoke
```

Revoked credentials cannot submit events. Re-enroll with a new token to restore a machine.

## Credential storage

| Place | Contents |
|-------|----------|
| Server DB `device_credentials` | **scrypt hash + salt only** |
| Local `device-credentials.json` | Plain secret for agent/extension on this Mac — do not commit |
| Chrome `storage.local` | Same secret after Sync — do not export publicly |

## Environment

| Variable | Meaning |
|----------|---------|
| `TRACKER_MODE` | `local` (default) or `central` |
| `TRACKER_ADMIN_TOKEN` | Required for admin APIs when not in local mode |
| `TRACKER_LOCAL_AUTO_PROVISION` | `1`/`0` — auto device on empty DB (default on in local) |
| `TRACKER_LOCAL_CREDENTIAL_READ` | Allow `/api/local/device-config` (default on in local) |
| `TRACKER_DEVICE_ID` / `TRACKER_DEVICE_SECRET` | Override credentials for Mac agent |
| `TRACKER_SKIP_BACKUP` | Skip pre-v3 DB file backup (tests) |

## Legacy data

Existing rows keep `device_id = NULL`. New authenticated events set `device_id` from auth. Analytics for the personal dashboard still include all local rows.
