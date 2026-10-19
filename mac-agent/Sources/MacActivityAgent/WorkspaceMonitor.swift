import AppKit
import ActivityCore
import Foundation

/// Observes NSWorkspace for frontmost-app changes. Polling is only a fallback.
public final class WorkspaceMonitor {
    public typealias AppHandler = (AppIdentity) -> Void
    public typealias VoidHandler = () -> Void

    private let workspace: NSWorkspace
    private var observers: [NSObjectProtocol] = []
    private var pollTimer: Timer?
    private let pollInterval: TimeInterval
    private var lastSeen: AppIdentity?

    public var onFrontmostChanged: AppHandler?
    public var onAppTerminated: AppHandler?
    public var onWillSleep: VoidHandler?
    public var onDidWake: VoidHandler?

    public init(workspace: NSWorkspace = .shared, pollInterval: TimeInterval = 2.0) {
        self.workspace = workspace
        self.pollInterval = pollInterval
    }

    public func start() {
        stop()
        let center = workspace.notificationCenter
        let nc = NSWorkspace.shared.notificationCenter

        observers.append(center.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleActivation(note)
        })

        observers.append(center.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // After deactivation, re-read frontmost (another app may already be active).
            self?.emitCurrentFrontmost()
        })

        observers.append(center.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.onAppTerminated?(Self.identity(from: app))
        })

        observers.append(nc.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.onWillSleep?()
        })

        observers.append(nc.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.onDidWake?()
        })

        // Fallback poll for missed notifications
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.emitCurrentFrontmost()
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer

        emitCurrentFrontmost()
    }

    public func stop() {
        for observer in observers {
            workspace.notificationCenter.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        observers.removeAll()
        pollTimer?.invalidate()
        pollTimer = nil
    }

    public func currentFrontmost() -> AppIdentity? {
        guard let app = workspace.frontmostApplication else { return nil }
        return Self.identity(from: app)
    }

    public static func identity(from app: NSRunningApplication) -> AppIdentity {
        AppIdentity(
            name: app.localizedName ?? app.bundleURL?.deletingPathExtension().lastPathComponent ?? "Unknown",
            bundleIdentifier: app.bundleIdentifier,
            processIdentifier: app.processIdentifier
        )
    }

    private func handleActivation(_ note: Notification) {
        if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
            let identity = Self.identity(from: app)
            emit(identity)
        } else {
            emitCurrentFrontmost()
        }
    }

    private func emitCurrentFrontmost() {
        guard let identity = currentFrontmost() else { return }
        emit(identity)
    }

    private func emit(_ identity: AppIdentity) {
        if let last = lastSeen, last.isSameApplication(as: identity) {
            return
        }
        lastSeen = identity
        onFrontmostChanged?(identity)
    }

    deinit {
        stop()
    }
}
