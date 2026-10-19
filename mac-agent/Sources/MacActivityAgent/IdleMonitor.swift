import ActivityCore
import CoreGraphics
import Foundation

/// Detects idle time using CoreGraphics last-input API (no Accessibility permission required).
final class IdleMonitor {
    var idleThreshold: TimeInterval
    var onIdleStarted: (() -> Void)?
    var onIdleEnded: (() -> Void)?

    private var timer: Timer?
    private(set) var isIdle = false
    private let checkInterval: TimeInterval

    init(idleThreshold: TimeInterval = 60, checkInterval: TimeInterval = 5) {
        self.idleThreshold = idleThreshold
        self.checkInterval = checkInterval
    }

    func start() {
        stop()
        let timer = Timer(timeInterval: checkInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if isIdle {
            isIdle = false
            onIdleEnded?()
        }
    }

    /// Seconds since any user input in this login session.
    static func secondsSinceLastInput() -> TimeInterval {
        // kCGAnyInputEventType == ~0
        CGEventSource.secondsSinceLastEventType(
            .combinedSessionState,
            eventType: CGEventType(rawValue: UInt32.max)!
        )
    }

    private func tick() {
        let idleFor = Self.secondsSinceLastInput()
        if !isIdle && idleFor >= idleThreshold {
            isIdle = true
            onIdleStarted?()
        } else if isIdle && idleFor < idleThreshold {
            isIdle = false
            onIdleEnded?()
        }
    }
}
