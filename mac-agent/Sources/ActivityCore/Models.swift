import Foundation

/// Snapshot of a running Mac application.
public struct AppIdentity: Equatable, Hashable, Codable, Sendable {
    public var name: String
    public var bundleIdentifier: String?
    public var processIdentifier: Int32?

    public init(name: String, bundleIdentifier: String? = nil, processIdentifier: Int32? = nil) {
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.processIdentifier = processIdentifier
    }

    /// Same app if bundle IDs match; otherwise fall back to name + pid.
    public func isSameApplication(as other: AppIdentity) -> Bool {
        if let a = bundleIdentifier, let b = other.bundleIdentifier, !a.isEmpty, !b.isEmpty {
            return a == b
        }
        if let pa = processIdentifier, let pb = other.processIdentifier {
            return name == other.name && pa == pb
        }
        return name == other.name
    }
}

public enum TrackerStatus: String, Codable, Sendable {
    case stopped
    case running
    case paused
}

public enum ActivityEventType: String, Codable, Sendable {
    case appActivated
    case appDeactivated
    case sessionStarted
    case sessionEnded
    case idleStarted
    case idleEnded
    case trackerStarted
    case trackerStopped
    case trackerPaused
    case trackerResumed
    case sleep
    case wake
    case gapDetected
    case error
    /// Privacy-safe window/project context for the open app session (no keystrokes).
    case contextUpdated
}

public enum OperationOutcome: String, Codable, Sendable {
    case success
    case failure
    case unknown
}

public struct ActivityEvent: Equatable, Codable, Sendable {
    public var id: String
    public var timestamp: Date
    public var type: ActivityEventType
    public var app: AppIdentity?
    public var sessionId: String?
    public var durationSeconds: Double?
    public var outcome: OperationOutcome
    public var metadata: [String: String]

    public init(
        id: String = UUID().uuidString,
        timestamp: Date = Date(),
        type: ActivityEventType,
        app: AppIdentity? = nil,
        sessionId: String? = nil,
        durationSeconds: Double? = nil,
        outcome: OperationOutcome = .unknown,
        metadata: [String: String] = [:]
    ) {
        self.id = id
        self.timestamp = timestamp
        self.type = type
        self.app = app
        self.sessionId = sessionId
        self.durationSeconds = durationSeconds
        self.outcome = outcome
        self.metadata = metadata
    }
}

public struct AppSession: Equatable, Codable, Sendable {
    public var id: String
    public var app: AppIdentity
    public var startedAt: Date
    public var endedAt: Date?
    public var wasIdle: Bool

    public init(
        id: String = UUID().uuidString,
        app: AppIdentity,
        startedAt: Date,
        endedAt: Date? = nil,
        wasIdle: Bool = false
    ) {
        self.id = id
        self.app = app
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.wasIdle = wasIdle
    }

    public var isOpen: Bool { endedAt == nil }

    public func duration(at date: Date = Date()) -> TimeInterval {
        let end = endedAt ?? date
        return max(0, end.timeIntervalSince(startedAt))
    }
}
