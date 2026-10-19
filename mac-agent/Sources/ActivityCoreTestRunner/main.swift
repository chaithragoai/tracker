import ActivityCore
import Foundation

/// Lightweight test runner for environments without XCTest (Command Line Tools only).
@main
struct ActivityCoreTestRunner {
    static func main() {
        var failures = 0
        let tests: [(String, () throws -> Void)] = [
            ("appSwitchCreatesNonOverlappingSessions", testAppSwitchCreatesNonOverlappingSessions),
            ("duplicateFrontmostDoesNotCreateNewSession", testDuplicateFrontmostDoesNotCreateNewSession),
            ("pauseEndsSessionAndResumeStartsFresh", testPauseEndsSessionAndResumeStartsFresh),
            ("excludedAppEndsSessionWithoutStartingNew", testExcludedAppEndsSessionWithoutStartingNew),
            ("sleepAndWake", testSleepAndWake),
            ("gapDetectedOnRestart", testGapDetectedOnRestart),
            ("sameBundleDifferentPidIsSameApp", testSameBundleDifferentPidIsSameApp),
            ("totalActiveSeconds", testTotalActiveSeconds),
            ("eventEncoderProducesJSON", testEventEncoderProducesJSON),
            ("idleStartAndEnd", testIdleStartAndEnd),
        ]
        for (name, body) in tests {
            failures += run(name, body)
        }
        if failures == 0 {
            print("ActivityCoreTestRunner: ALL PASSED (\(tests.count) tests)")
            exit(0)
        }
        print("ActivityCoreTestRunner: \(failures) FAILED")
        exit(1)
    }
}

private func run(_ name: String, _ body: () throws -> Void) -> Int {
    do {
        try body()
        print("PASS \(name)")
        return 0
    } catch {
        print("FAIL \(name): \(error)")
        return 1
    }
}

private struct Expectation: Error, CustomStringConvertible {
    let description: String
}

private func expect(_ condition: Bool, _ message: String) throws {
    if !condition { throw Expectation(description: message) }
}

private func expectEq<T: Equatable>(_ a: T, _ b: T, _ message: String) throws {
    try expect(a == b, "\(message) — got \(String(describing: a)) expected \(String(describing: b))")
}

private func expectApprox(_ a: Double, _ b: Double, accuracy: Double, _ message: String) throws {
    try expect(abs(a - b) <= accuracy, "\(message) — got \(a) expected \(b)")
}

private final class ClockBox {
    var date: Date
    init(_ date: Date) { self.date = date }
}

private final class IdBox {
    var seq = 0
}

private final class Harness {
    let box: ClockBox
    let manager: SessionManager

    init() {
        let box = ClockBox(Date(timeIntervalSince1970: 1_700_000_000))
        let ids = IdBox()
        self.box = box
        self.manager = SessionManager(
            clock: { box.date },
            idFactory: {
                ids.seq += 1
                return "id-\(ids.seq)"
            }
        )
    }

    func advance(_ seconds: TimeInterval) {
        box.date = box.date.addingTimeInterval(seconds)
    }

    var now: Date { box.date }
}

private func testAppSwitchCreatesNonOverlappingSessions() throws {
    let h = Harness()
    h.manager.start()
    let finder = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
    let textEdit = AppIdentity(name: "TextEdit", bundleIdentifier: "com.apple.TextEdit", processIdentifier: 2)
    let calc = AppIdentity(name: "Calculator", bundleIdentifier: "com.apple.calculator", processIdentifier: 3)

    _ = h.manager.noteFrontmost(finder, at: h.now)
    h.advance(10)
    _ = h.manager.noteFrontmost(textEdit, at: h.now)
    h.advance(5)
    _ = h.manager.noteFrontmost(calc, at: h.now)
    h.advance(7)
    _ = h.manager.stop()

    try expectEq(h.manager.closedSessions.count, 3, "closed session count")
    let s0 = h.manager.closedSessions[0]
    let s1 = h.manager.closedSessions[1]
    let s2 = h.manager.closedSessions[2]
    try expectEq(s0.app.bundleIdentifier, Optional("com.apple.finder"), "s0 app")
    try expectEq(s1.app.bundleIdentifier, Optional("com.apple.TextEdit"), "s1 app")
    try expectEq(s2.app.bundleIdentifier, Optional("com.apple.calculator"), "s2 app")
    try expectEq(s0.endedAt, s1.startedAt, "s0 ends when s1 starts")
    try expectEq(s1.endedAt, s2.startedAt, "s1 ends when s2 starts")
    try expectApprox(s0.duration(), 10, accuracy: 0.001, "s0 duration")
    try expectApprox(s1.duration(), 5, accuracy: 0.001, "s1 duration")
    try expectApprox(s2.duration(), 7, accuracy: 0.001, "s2 duration")
}

private func testDuplicateFrontmostDoesNotCreateNewSession() throws {
    let h = Harness()
    h.manager.start()
    let app = AppIdentity(name: "Cursor", bundleIdentifier: "com.todesktop.230313mzl4w4u92", processIdentifier: 9)
    try expectEq(h.manager.noteFrontmost(app).count, 2, "first activation events")
    h.advance(3)
    try expect(h.manager.noteFrontmost(app).isEmpty, "duplicate should be ignored")
    try expectEq(h.manager.closedSessions.count, 0, "no closed sessions")
    try expect(h.manager.currentSession != nil, "session still open")
}

private func testPauseEndsSessionAndResumeStartsFresh() throws {
    let h = Harness()
    h.manager.start()
    let app = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
    _ = h.manager.noteFrontmost(app)
    h.advance(4)
    _ = h.manager.pause()
    try expectEq(h.manager.status, .paused, "paused")
    try expect(h.manager.currentSession == nil, "no open session while paused")
    try expectEq(h.manager.closedSessions.count, 1, "one closed")
    try expectApprox(h.manager.closedSessions[0].duration(), 4, accuracy: 0.001, "paused duration")
    h.advance(2)
    _ = h.manager.resume(frontmost: app)
    try expectEq(h.manager.status, .running, "running")
    try expect(h.manager.currentSession != nil, "resumed session")
}

private func testExcludedAppEndsSessionWithoutStartingNew() throws {
    let h = Harness()
    h.manager.start()
    h.manager.excludedBundleIdentifiers = ["com.apple.Passwords"]
    let finder = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
    let privateApp = AppIdentity(name: "Passwords", bundleIdentifier: "com.apple.Passwords", processIdentifier: 2)
    _ = h.manager.noteFrontmost(finder)
    h.advance(3)
    let events = h.manager.noteFrontmost(privateApp)
    try expect(events.contains { $0.type == .sessionEnded }, "ended prior session")
    try expect(h.manager.currentSession == nil, "no session for excluded app")
    try expect(
        !events.contains { $0.type == .sessionStarted && $0.app?.bundleIdentifier == "com.apple.Passwords" },
        "no start for excluded"
    )
}

private func testSleepAndWake() throws {
    let h = Harness()
    h.manager.start()
    let app = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
    _ = h.manager.noteFrontmost(app)
    h.advance(2)
    _ = h.manager.noteSleep()
    try expect(h.manager.currentSession == nil, "session closed on sleep")
    try expect(h.manager.events.contains { $0.type == .sleep }, "sleep event")
    h.advance(10)
    _ = h.manager.noteWake(frontmost: app)
    try expect(h.manager.events.contains { $0.type == .wake }, "wake event")
    try expect(h.manager.currentSession != nil, "session after wake")
}

private func testGapDetectedOnRestart() throws {
    let h = Harness()
    let start = h.now
    h.advance(30)
    let gap = h.manager.noteGap(from: start, to: h.now, reason: "tracker_restart")
    try expectEq(gap.type, .gapDetected, "gap type")
    try expectEq(gap.outcome, .unknown, "gap outcome")
    try expectEq(gap.metadata["reason"], Optional("tracker_restart"), "gap reason")
}

private func testSameBundleDifferentPidIsSameApp() throws {
    let h = Harness()
    h.manager.start()
    let a = AppIdentity(name: "Safari", bundleIdentifier: "com.apple.Safari", processIdentifier: 10)
    let b = AppIdentity(name: "Safari", bundleIdentifier: "com.apple.Safari", processIdentifier: 99)
    _ = h.manager.noteFrontmost(a)
    h.advance(1)
    try expect(h.manager.noteFrontmost(b).isEmpty, "same bundle is same app")
}

private func testTotalActiveSeconds() throws {
    let h = Harness()
    h.manager.start()
    let finder = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
    let te = AppIdentity(name: "TextEdit", bundleIdentifier: "com.apple.TextEdit", processIdentifier: 2)
    _ = h.manager.noteFrontmost(finder)
    h.advance(10)
    _ = h.manager.noteFrontmost(te)
    h.advance(5)
    try expectApprox(h.manager.totalActiveSeconds(forBundleId: "com.apple.finder"), 10, accuracy: 0.001, "finder total")
    try expectApprox(h.manager.totalActiveSeconds(forBundleId: "com.apple.TextEdit"), 5, accuracy: 0.001, "textedit total")
}

private func testIdleStartAndEnd() throws {
    let h = Harness()
    h.manager.start()
    let app = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
    _ = h.manager.noteFrontmost(app)
    let started = h.manager.noteIdleStarted()
    try expectEq(started.count, 1, "idle started")
    try expect(h.manager.currentSession?.wasIdle == true, "session marked idle")
    try expect(h.manager.noteIdleStarted().isEmpty, "duplicate idle ignored")
    h.advance(12)
    let ended = h.manager.noteIdleEnded()
    try expectEq(ended.count, 1, "idle ended")
    try expectApprox(ended[0].durationSeconds ?? -1, 12, accuracy: 0.001, "idle duration")
}

private func testEventEncoderProducesJSON() throws {
    let event = ActivityEvent(
        id: "e1",
        timestamp: Date(timeIntervalSince1970: 1_700_000_000),
        type: .appActivated,
        app: AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1),
        sessionId: "s1",
        outcome: .success
    )
    let line = try EventEncoder.jsonLine(from: event)
    try expect(line.contains("\"type\":\"appActivated\""), "type field")
    try expect(line.contains("com.apple.finder"), "bundle id")
    try expect(line.contains("\"outcome\":\"success\""), "outcome")
}
