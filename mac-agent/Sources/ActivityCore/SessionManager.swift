import Foundation

/// Pure session engine: no AppKit. Easy to unit-test with fake app switches.
public final class SessionManager: @unchecked Sendable {
    public private(set) var status: TrackerStatus = .stopped
    public private(set) var currentSession: AppSession?
    public private(set) var closedSessions: [AppSession] = []
    public private(set) var events: [ActivityEvent] = []

    /// Private app bundle IDs that should not create sessions.
    public var excludedBundleIdentifiers: Set<String> = []
    /// Private app names (case-insensitive) when bundle ID is missing.
    public var excludedAppNames: Set<String> = []

    private let clock: () -> Date
    private let idFactory: () -> String

    public init(clock: @escaping () -> Date = Date.init, idFactory: @escaping () -> String = { UUID().uuidString }) {
        self.clock = clock
        self.idFactory = idFactory
    }

    public var isTracking: Bool { status == .running }

    @discardableResult
    public func start() -> ActivityEvent {
        status = .running
        let event = makeEvent(type: .trackerStarted, outcome: .success)
        append(event)
        return event
    }

    @discardableResult
    public func stop() -> [ActivityEvent] {
        var produced: [ActivityEvent] = []
        if let closed = endCurrentSession(reason: "tracker_stopped") {
            produced.append(contentsOf: closed)
        }
        status = .stopped
        let event = makeEvent(type: .trackerStopped, outcome: .success)
        append(event)
        produced.append(event)
        return produced
    }

    @discardableResult
    public func pause() -> [ActivityEvent] {
        var produced: [ActivityEvent] = []
        if let closed = endCurrentSession(reason: "tracker_paused") {
            produced.append(contentsOf: closed)
        }
        status = .paused
        let event = makeEvent(type: .trackerPaused, outcome: .success)
        append(event)
        produced.append(event)
        return produced
    }

    @discardableResult
    public func resume(frontmost: AppIdentity?) -> [ActivityEvent] {
        status = .running
        var produced: [ActivityEvent] = []
        let event = makeEvent(type: .trackerResumed, outcome: .success)
        append(event)
        produced.append(event)
        if let frontmost {
            produced.append(contentsOf: noteFrontmost(frontmost))
        }
        return produced
    }

    /// Call when the frontmost application is known (notification or poll).
    @discardableResult
    public func noteFrontmost(_ app: AppIdentity, at date: Date? = nil) -> [ActivityEvent] {
        guard status == .running else { return [] }
        let now = date ?? clock()

        if isExcluded(app) {
            return endCurrentSession(reason: "excluded_app", at: now) ?? []
        }

        if let current = currentSession, current.app.isSameApplication(as: app) {
            return []
        }

        var produced: [ActivityEvent] = []
        if let closed = endCurrentSession(reason: "app_switch", at: now) {
            produced.append(contentsOf: closed)
        }

        let session = AppSession(id: idFactory(), app: app, startedAt: now)
        currentSession = session

        let activated = makeEvent(
            type: .appActivated,
            at: now,
            app: app,
            sessionId: session.id,
            outcome: .success
        )
        let started = makeEvent(
            type: .sessionStarted,
            at: now,
            app: app,
            sessionId: session.id,
            outcome: .success
        )
        append(activated)
        append(started)
        produced.append(activated)
        produced.append(started)
        return produced
    }

    /// Call when an app terminates; ends session only if it was that app.
    @discardableResult
    public func noteAppTerminated(_ app: AppIdentity, at date: Date? = nil) -> [ActivityEvent] {
        guard status == .running else { return [] }
        guard let current = currentSession, current.app.isSameApplication(as: app) else { return [] }
        return endCurrentSession(reason: "app_terminated", at: date ?? clock()) ?? []
    }

    @discardableResult
    public func noteSleep(at date: Date? = nil) -> [ActivityEvent] {
        let now = date ?? clock()
        var produced: [ActivityEvent] = []
        if let closed = endCurrentSession(reason: "system_sleep", at: now) {
            produced.append(contentsOf: closed)
        }
        let event = makeEvent(type: .sleep, at: now, outcome: .success)
        append(event)
        produced.append(event)
        return produced
    }

    @discardableResult
    public func noteWake(frontmost: AppIdentity?, at date: Date? = nil) -> [ActivityEvent] {
        let now = date ?? clock()
        var produced: [ActivityEvent] = []
        let wake = makeEvent(type: .wake, at: now, outcome: .success)
        append(wake)
        produced.append(wake)
        if status == .running, let frontmost {
            produced.append(contentsOf: noteFrontmost(frontmost, at: now))
        }
        return produced
    }

    /// Mark a gap when the tracker was offline (restart recovery). Does not invent activity.
    @discardableResult
    public func noteGap(from start: Date, to end: Date, reason: String) -> ActivityEvent {
        let event = ActivityEvent(
            id: idFactory(),
            timestamp: end,
            type: .gapDetected,
            outcome: .unknown,
            metadata: [
                "gapStart": ISO8601Codec.string(from: start),
                "gapEnd": ISO8601Codec.string(from: end),
                "reason": reason,
            ]
        )
        append(event)
        return event
    }

    public private(set) var idleStartedAt: Date?

    @discardableResult
    public func noteIdleStarted(at date: Date? = nil) -> [ActivityEvent] {
        guard status == .running else { return [] }
        guard idleStartedAt == nil else { return [] }
        let now = date ?? clock()
        idleStartedAt = now
        if var session = currentSession {
            session.wasIdle = true
            currentSession = session
        }
        let event = makeEvent(
            type: .idleStarted,
            at: now,
            app: currentSession?.app,
            sessionId: currentSession?.id,
            outcome: .success
        )
        append(event)
        return [event]
    }

    @discardableResult
    public func noteIdleEnded(at date: Date? = nil) -> [ActivityEvent] {
        guard let started = idleStartedAt else { return [] }
        let now = date ?? clock()
        idleStartedAt = nil
        let duration = max(0, now.timeIntervalSince(started))
        let event = makeEvent(
            type: .idleEnded,
            at: now,
            app: currentSession?.app,
            sessionId: currentSession?.id,
            durationSeconds: duration,
            outcome: .success
        )
        append(event)
        return [event]
    }

    public func totalActiveSeconds(forBundleId bundleId: String) -> Double {
        var total: Double = 0
        for session in closedSessions where session.app.bundleIdentifier == bundleId && !session.wasIdle {
            total += session.duration()
        }
        if let current = currentSession,
           current.app.bundleIdentifier == bundleId,
           !current.wasIdle {
            total += current.duration(at: clock())
        }
        return total
    }

    // MARK: - Internals

    private func isExcluded(_ app: AppIdentity) -> Bool {
        if let bid = app.bundleIdentifier, excludedBundleIdentifiers.contains(bid) {
            return true
        }
        return excludedAppNames.contains(app.name.lowercased())
    }

    @discardableResult
    private func endCurrentSession(reason: String, at date: Date? = nil) -> [ActivityEvent]? {
        guard var session = currentSession else { return nil }
        let now = date ?? clock()
        // Avoid overlapping / negative intervals
        if now < session.startedAt {
            session.endedAt = session.startedAt
        } else {
            session.endedAt = now
        }
        currentSession = nil
        closedSessions.append(session)

        let duration = session.duration()
        let deactivated = makeEvent(
            type: .appDeactivated,
            at: now,
            app: session.app,
            sessionId: session.id,
            durationSeconds: duration,
            outcome: .success,
            metadata: ["reason": reason]
        )
        let ended = makeEvent(
            type: .sessionEnded,
            at: now,
            app: session.app,
            sessionId: session.id,
            durationSeconds: duration,
            outcome: .success,
            metadata: ["reason": reason]
        )
        append(deactivated)
        append(ended)
        return [deactivated, ended]
    }

    private func makeEvent(
        type: ActivityEventType,
        at date: Date? = nil,
        app: AppIdentity? = nil,
        sessionId: String? = nil,
        durationSeconds: Double? = nil,
        outcome: OperationOutcome = .unknown,
        metadata: [String: String] = [:]
    ) -> ActivityEvent {
        ActivityEvent(
            id: idFactory(),
            timestamp: date ?? clock(),
            type: type,
            app: app,
            sessionId: sessionId,
            durationSeconds: durationSeconds,
            outcome: outcome,
            metadata: metadata
        )
    }

    private func append(_ event: ActivityEvent) {
        events.append(event)
    }
}

public enum ISO8601Codec {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let fallback: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func string(from date: Date) -> String {
        formatter.string(from: date)
    }

    public static func date(from string: String) -> Date? {
        formatter.date(from: string) ?? fallback.date(from: string)
    }
}
