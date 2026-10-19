# E2E Smoke Test Plan — Activity Tracker

**Inspected:** 2026-10-15  
**App URL:** http://127.0.0.1:8787  
**Routing model:** Single-page app (sidebar `data-view` switches). No URL routes per tab — refresh returns to Overview (expected).

## Discovered tabs / views (11)

| # | Tab label | View id | Primary actions to smoke-test |
|---|-----------|---------|-------------------------------|
| 1 | Overview | `overview` | Date chips, Refresh, summary cards, charts |
| 2 | App Usage | `apps` | Chart + ranked list |
| 3 | Browser Activity | `browser` | Website chart + ops list |
| 4 | Timeline | `timeline` | Session list, idle, gaps |
| 5 | Search | `search` | Query + Search button |
| 6 | Assistant | `assistant` | Ask question |
| 7 | Daily Briefing | `briefing` | Generate briefing |
| 8 | Tasks | `tasks` | Add task, Suggest |
| 9 | Memories | `memories` | Save memory, Add project |
| 10 | Activity History | `history` | Filters + Apply |
| 11 | Reports & Privacy | `reports` | HTML report, CSV/JSON links, backup, save settings, pause |

## Global chrome (always visible)

- Sidebar brand + tracking health + current app/tab
- Date range: Today / Yesterday / Last 7 Days / Custom
- Refresh, status pill

## Playwright

- **None found** in repo — smoke suite will be added under `e2e/` only (no product UI changes).

## Not present (skip / NOT RUN as product features)

- Multi-device inventory, employee management, login/auth pages
- Separate URL routes per tab
- Device-management admin UI
