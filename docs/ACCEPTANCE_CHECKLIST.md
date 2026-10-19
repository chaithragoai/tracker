# Manual acceptance checklist (simple)

## Always keep running
1. Server: dashboard at http://127.0.0.1:8787 should open.
2. Mac agent: in Terminal, `cd mac-agent && swift run MacActivityAgent`
3. Chrome: `chrome://extensions` → reload **Mac Activity Tracker** (needed after Phase 1 changes).

## Tracking
- [ ] Switch apps (Finder → TextEdit → Cursor); Overview updates.
- [ ] Sidebar **Tracking health** mentions Mac last event after agent runs.
- [ ] Open two websites, switch tabs; new `tabSessionStarted` events appear (Search or History).
- [ ] Extension popup shows server connected after ~1 minute heartbeat (or reopen popup after browsing).
- [ ] Pause from extension popup; tab switches stop creating events; Resume restores them.

## Analytics
- [ ] Overview donuts show real apps/websites for Today.
- [ ] Last 7 Days changes the charts.
- [ ] Empty custom day shows empty states (no fake apps).

## New assistant features
- [ ] **Search**: query `chrome` or a domain you visited.
- [ ] **Assistant**: ask “What apps did I use today?”
- [ ] **Daily Briefing**: Generate briefing — facts listed, estimates labeled.
- [ ] **Tasks**: Add a task; use Suggest; Confirm before it counts as yours.
- [ ] **Memories**: Save a note; find it via Search.
- [ ] **Reports & Privacy**: CSV/JSON export; privacy settings still save.

## Not enabled (by design)
- Screen Rewind — off; see `docs/SCREEN_AND_MEETINGS.md`
- Meeting audio — off; same doc
