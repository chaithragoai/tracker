import ActivityCore
import Foundation

/// Wires WorkspaceMonitor → SessionManager → EventSink and exposes status.
final class AgentController {
    let sessions: SessionManager
    private let monitor: WorkspaceMonitor
    private let idleMonitor: IdleMonitor
    private let sink: EventSink
    private let stateURL: URL
    private var contextTimer: Timer?
    private var lastWindowTitle: String?

    private(set) var lastFrontmost: AppIdentity?

    init(
        sessions: SessionManager = SessionManager(),
        monitor: WorkspaceMonitor = WorkspaceMonitor(),
        idleMonitor: IdleMonitor = IdleMonitor(idleThreshold: 60),
        sink: EventSink,
        stateURL: URL
    ) {
        self.sessions = sessions
        self.monitor = monitor
        self.idleMonitor = idleMonitor
        self.sink = sink
        self.stateURL = stateURL
    }

    var statusLine: String {
        let status = sessions.status.rawValue.uppercased()
        let app = lastFrontmost?.name ?? sessions.currentSession?.app.name ?? "(none)"
        let bid = lastFrontmost?.bundleIdentifier ?? sessions.currentSession?.app.bundleIdentifier ?? "-"
        let titleBit = lastWindowTitle.map { " title=\($0.prefix(40))" } ?? ""
        return "[\(status)] frontmost=\(app) bundle=\(bid)\(titleBit)"
    }

    func start() {
        loadExclusions()
        recoverFromRestart()

        for event in [sessions.start()].flatMap({ [$0] }) {
            sink.emit(event)
        }

        monitor.onFrontmostChanged = { [weak self] app in
            guard let self else { return }
            self.lastFrontmost = app
            let title = WindowTitleSampler.title(for: app)
            self.lastWindowTitle = title
            for var event in self.sessions.noteFrontmost(app) {
                self.attachWindowContext(&event, title: title)
                self.sink.emit(event)
            }
            self.persistState()
            fputs(self.statusLine + "\n", stderr)
        }

        monitor.onAppTerminated = { [weak self] app in
            guard let self else { return }
            for event in self.sessions.noteAppTerminated(app) {
                self.sink.emit(event)
            }
            self.persistState()
        }

        monitor.onWillSleep = { [weak self] in
            guard let self else { return }
            for event in self.sessions.noteSleep() {
                self.sink.emit(event)
            }
            self.persistState()
        }

        monitor.onDidWake = { [weak self] in
            guard let self else { return }
            let front = self.monitor.currentFrontmost()
            self.lastFrontmost = front
            for event in self.sessions.noteWake(frontmost: front) {
                self.sink.emit(event)
            }
            self.persistState()
        }

        idleMonitor.onIdleStarted = { [weak self] in
            guard let self else { return }
            for event in self.sessions.noteIdleStarted() {
                self.sink.emit(event)
            }
            self.persistState()
            fputs("[IDLE] started\n", stderr)
        }
        idleMonitor.onIdleEnded = { [weak self] in
            guard let self else { return }
            for event in self.sessions.noteIdleEnded() {
                self.sink.emit(event)
            }
            self.persistState()
            fputs("[IDLE] ended\n", stderr)
        }

        monitor.start()
        idleMonitor.start()
        startContextSampling()
        persistState()
        fputs("Mac Activity Agent started. \(statusLine)\n", stderr)
        fputs("Commands: type 'status', 'pause', 'resume', 'stop' then Enter.\n", stderr)
        fputs("Note: Window titles for Cursor/IDE need Screen Recording permission (System Settings → Privacy).\n", stderr)
    }

    func pause() {
        for event in sessions.pause() {
            sink.emit(event)
        }
        persistState()
        fputs(statusLine + "\n", stderr)
    }

    func resume() {
        let front = monitor.currentFrontmost()
        lastFrontmost = front
        let title = front.flatMap { WindowTitleSampler.title(for: $0) }
        lastWindowTitle = title
        for var event in sessions.resume(frontmost: front) {
            attachWindowContext(&event, title: title)
            sink.emit(event)
        }
        persistState()
        fputs(statusLine + "\n", stderr)
    }

    func stop() {
        contextTimer?.invalidate()
        contextTimer = nil
        idleMonitor.stop()
        monitor.stop()
        for event in sessions.noteIdleEnded() {
            sink.emit(event)
        }
        for event in sessions.stop() {
            sink.emit(event)
        }
        persistState()
        fputs("Mac Activity Agent stopped.\n", stderr)
    }

    // MARK: - Window context (privacy-safe)

    private func startContextSampling() {
        contextTimer?.invalidate()
        let timer = Timer(timeInterval: 20, repeats: true) { [weak self] _ in
            self?.sampleWindowContext()
        }
        RunLoop.main.add(timer, forMode: .common)
        contextTimer = timer
    }

    private func sampleWindowContext() {
        guard sessions.status == .running else { return }
        guard let app = lastFrontmost ?? monitor.currentFrontmost() else { return }
        guard WindowTitleSampler.isInteresting(app) else { return }
        guard let sessionId = sessions.currentSession?.id else { return }
        let title = WindowTitleSampler.title(for: app)
        guard let title, title != lastWindowTitle else { return }
        lastWindowTitle = title
        var event = ActivityEvent(
            type: .contextUpdated,
            app: app,
            sessionId: sessionId,
            outcome: .success,
            metadata: [:]
        )
        attachWindowContext(&event, title: title)
        sink.emit(event)
    }

    private func attachWindowContext(_ event: inout ActivityEvent, title: String?) {
        guard let title, !title.isEmpty else { return }
        event.metadata["windowTitle"] = title
        if let hint = WindowTitleSampler.projectHint(from: title) {
            event.metadata["projectHint"] = hint
        }
        event.metadata["semantic"] = "window_context"
    }

    // MARK: - Restart recovery

    private struct PersistedState: Codable {
        var status: String
        var lastEventAt: Date?
        var openSessionStartedAt: Date?
        var openSessionAppName: String?
        var openSessionBundleId: String?
    }

    private func recoverFromRestart() {
        guard let data = try? Data(contentsOf: stateURL),
              let state = try? JSONDecoder().decode(PersistedState.self, from: data),
              let last = state.lastEventAt else {
            return
        }
        let now = Date()
        // If we died with an open session, mark a gap instead of inventing activity.
        if state.openSessionStartedAt != nil {
            let gap = sessions.noteGap(from: last, to: now, reason: "tracker_restart")
            sink.emit(gap)
        } else if now.timeIntervalSince(last) > 5 {
            let gap = sessions.noteGap(from: last, to: now, reason: "tracker_offline")
            sink.emit(gap)
        }
    }

    private func persistState() {
        let current = sessions.currentSession
        let state = PersistedState(
            status: sessions.status.rawValue,
            lastEventAt: sessions.events.last?.timestamp ?? Date(),
            openSessionStartedAt: current?.startedAt,
            openSessionAppName: current?.app.name,
            openSessionBundleId: current?.app.bundleIdentifier
        )
        do {
            let data = try JSONEncoder().encode(state)
            try data.write(to: stateURL, options: .atomic)
        } catch {
            fputs("state persist error: \(error)\n", stderr)
        }
    }

    private func loadExclusions() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let path = home
            .appendingPathComponent("Library/Application Support/MacActivityTracker/exclusions.json")
        guard let data = try? Data(contentsOf: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        if let bundles = obj["bundleIdentifiers"] as? [String] {
            sessions.excludedBundleIdentifiers = Set(bundles)
        }
        if let names = obj["appNames"] as? [String] {
            sessions.excludedAppNames = Set(names.map { $0.lowercased() })
        }
    }
}
