# Screen Rewind & Meeting Assistant — investigation

**Status:** Not implemented. Intentionally OFF. No capture code shipped.

## Screen Rewind (macOS)

### Feasible approach
- Use ScreenCaptureKit (macOS 12.3+) or CGWindowList / screencapture APIs with **user-granted** Screen Recording permission in System Settings → Privacy & Security → Screen Recording.
- Store encrypted or access-controlled local frames with retention limits.
- OCR via Vision framework locally.

### Blockers / risks in current architecture
1. Requires explicit macOS Screen Recording permission (user must approve in Settings).
2. High disk use; needs retention UI before enabling.
3. Must exclude password managers, banking, auth screens by bundle ID / URL.
4. Swift agent today is a CLI Process — a long-running capture loop needs careful battery/CPU design.
5. Cannot bypass TCC protections.

### Phased plan (when you ask to enable)
1. Preference flag default OFF + visible “recording” indicator.
2. Capture interval + exclusion lists.
3. Local thumbnail timeline + optional OCR search.
4. Never upload without separate consent.

## Meeting / audio assistant

### Feasible approach
- Detect Zoom/Teams/Meet as foreground apps (already possible via bundle IDs).
- Audio only via AVAudioEngine / ScreenCaptureKit audio with **Microphone** (and possibly additional) permissions.
- Local speech recognition (SFSpeechRecognizer) or optional cloud STT with disclosure.

### Blockers
1. Microphone permission required; recording must be visibly indicated.
2. Legal/consent: do not record others without consent.
3. Cloud STT would leave the device — must stay optional and disclosed.
4. Not required for core activity assistant reliability.

### Recommendation
Ship core tracking, search, briefing, tasks, and privacy first. Revisit capture only after you explicitly request it and accept the permission prompts.
