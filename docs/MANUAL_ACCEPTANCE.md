# Manual acceptance checklist

## macOS agent

- [ ] Start server (`cd server && npm start`) and agent (`cd mac-agent && swift run MacActivityAgent`)
- [ ] Status line shows frontmost app
- [ ] Switch Finder → TextEdit → Calculator; events appear in dashboard timeline
- [ ] Type `pause` then `resume` in the agent terminal
- [ ] Sleep/wake Mac (or close lid briefly); sleep/wake or gap events appear
- [ ] Quit and restart agent; a `gapDetected` event appears if time passed

## Chrome extension

- [ ] Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `extension/`
- [ ] Open two tabs; switch between them; tab sessions appear in dashboard
- [ ] Navigate to a normal https site; `navigation` / `tabSessionStarted` recorded
- [ ] Click a button/link; `click` operation with semantic label appears
- [ ] Submit a harmless search box; `search` event appears (no query text by default)
- [ ] Confirm `chrome://settings` does **not** inject content script errors beyond protected-page limits
- [ ] Pause from extension popup; new tab switches stop posting

## Privacy

- [ ] Add an excluded domain in dashboard settings; visits are not stored as tab sessions
- [ ] Add excluded bundle ID; focusing that app ends/skips sessions
- [ ] Confirm AI summaries remain off unless consent + enable are both checked
- [ ] Confirm no password field values appear in event metadata

## Reports

- [ ] Generate daily HTML report from dashboard; open the file
- [ ] Download CSV export
- [ ] Create database backup

## Login startup (optional)

- [ ] Copy LaunchAgent plists from `packaging/launchd/`, replace paths, `launchctl load`
- [ ] Log out/in; server and agent start without Terminal
