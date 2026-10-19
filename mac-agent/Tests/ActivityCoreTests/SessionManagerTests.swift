import XCTest
@testable import ActivityCore

final class SessionManagerTests: XCTestCase {
    private var clock: Date!
    private var seq: Int!
    private var manager: SessionManager!

    override func setUp() {
        super.setUp()
        clock = Date(timeIntervalSince1970: 1_700_000_000)
        seq = 0
        manager = SessionManager(
            clock: { [unowned self] in self.clock },
            idFactory: { [unowned self] in
                self.seq += 1
                return "id-\(self.seq!)"
            }
        )
    }

    func testAppSwitchCreatesNonOverlappingSessions() {
        manager.start()
        let finder = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
        let textEdit = AppIdentity(name: "TextEdit", bundleIdentifier: "com.apple.TextEdit", processIdentifier: 2)
        let calc = AppIdentity(name: "Calculator", bundleIdentifier: "com.apple.calculator", processIdentifier: 3)

        _ = manager.noteFrontmost(finder, at: clock)
        advance(10)
        _ = manager.noteFrontmost(textEdit, at: clock)
        advance(5)
        _ = manager.noteFrontmost(calc, at: clock)
        advance(7)
        _ = manager.stop()

        XCTAssertEqual(manager.closedSessions.count, 3)

        let s0 = manager.closedSessions[0]
        let s1 = manager.closedSessions[1]
        let s2 = manager.closedSessions[2]

        XCTAssertEqual(s0.app.bundleIdentifier, "com.apple.finder")
        XCTAssertEqual(s1.app.bundleIdentifier, "com.apple.TextEdit")
        XCTAssertEqual(s2.app.bundleIdentifier, "com.apple.calculator")

        // No overlaps: each end == next start
        XCTAssertEqual(s0.endedAt, s1.startedAt)
        XCTAssertEqual(s1.endedAt, s2.startedAt)

        XCTAssertEqual(s0.duration(), 10, accuracy: 0.001)
        XCTAssertEqual(s1.duration(), 5, accuracy: 0.001)
        XCTAssertEqual(s2.duration(), 7, accuracy: 0.001)
    }

    func testDuplicateFrontmostDoesNotCreateNewSession() {
        manager.start()
        let app = AppIdentity(name: "Cursor", bundleIdentifier: "com.todesktop.230313mzl4w4u92", processIdentifier: 9)
        XCTAssertEqual(manager.noteFrontmost(app).count, 2) // activated + sessionStarted
        advance(3)
        XCTAssertTrue(manager.noteFrontmost(app).isEmpty)
        XCTAssertEqual(manager.closedSessions.count, 0)
        XCTAssertNotNil(manager.currentSession)
    }

    func testPauseEndsSessionAndResumeStartsFresh() {
        manager.start()
        let app = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
        _ = manager.noteFrontmost(app)
        advance(4)
        _ = manager.pause()
        XCTAssertEqual(manager.status, .paused)
        XCTAssertNil(manager.currentSession)
        XCTAssertEqual(manager.closedSessions.count, 1)
        XCTAssertEqual(manager.closedSessions[0].duration(), 4, accuracy: 0.001)

        advance(2)
        _ = manager.resume(frontmost: app)
        XCTAssertEqual(manager.status, .running)
        XCTAssertNotNil(manager.currentSession)
        XCTAssertEqual(manager.currentSession?.app.bundleIdentifier, "com.apple.finder")
    }

    func testExcludedAppEndsSessionWithoutStartingNew() {
        manager.start()
        manager.excludedBundleIdentifiers = ["com.apple.Passwords"]
        let finder = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
        let privateApp = AppIdentity(name: "Passwords", bundleIdentifier: "com.apple.Passwords", processIdentifier: 2)

        _ = manager.noteFrontmost(finder)
        advance(3)
        let events = manager.noteFrontmost(privateApp)
        XCTAssertTrue(events.contains { $0.type == .sessionEnded })
        XCTAssertNil(manager.currentSession)
        XCTAssertFalse(events.contains { $0.type == .sessionStarted && $0.app?.bundleIdentifier == "com.apple.Passwords" })
    }

    func testSleepAndWake() {
        manager.start()
        let app = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
        _ = manager.noteFrontmost(app)
        advance(2)
        _ = manager.noteSleep()
        XCTAssertNil(manager.currentSession)
        XCTAssertTrue(manager.events.contains { $0.type == .sleep })

        advance(10)
        _ = manager.noteWake(frontmost: app)
        XCTAssertTrue(manager.events.contains { $0.type == .wake })
        XCTAssertNotNil(manager.currentSession)
    }

    func testGapDetectedOnRestart() {
        let start = clock!
        advance(30)
        let gap = manager.noteGap(from: start, to: clock, reason: "tracker_restart")
        XCTAssertEqual(gap.type, .gapDetected)
        XCTAssertEqual(gap.outcome, .unknown)
        XCTAssertEqual(gap.metadata["reason"], "tracker_restart")
    }

    func testSameBundleDifferentPidIsSameApp() {
        manager.start()
        let a = AppIdentity(name: "Safari", bundleIdentifier: "com.apple.Safari", processIdentifier: 10)
        let b = AppIdentity(name: "Safari", bundleIdentifier: "com.apple.Safari", processIdentifier: 99)
        _ = manager.noteFrontmost(a)
        advance(1)
        XCTAssertTrue(manager.noteFrontmost(b).isEmpty)
    }

    func testTotalActiveSeconds() {
        manager.start()
        let finder = AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1)
        let te = AppIdentity(name: "TextEdit", bundleIdentifier: "com.apple.TextEdit", processIdentifier: 2)
        _ = manager.noteFrontmost(finder)
        advance(10)
        _ = manager.noteFrontmost(te)
        advance(5)
        XCTAssertEqual(manager.totalActiveSeconds(forBundleId: "com.apple.finder"), 10, accuracy: 0.001)
        XCTAssertEqual(manager.totalActiveSeconds(forBundleId: "com.apple.TextEdit"), 5, accuracy: 0.001)
    }

    func testEventEncoderProducesJSON() throws {
        let event = ActivityEvent(
            id: "e1",
            timestamp: Date(timeIntervalSince1970: 1_700_000_000),
            type: .appActivated,
            app: AppIdentity(name: "Finder", bundleIdentifier: "com.apple.finder", processIdentifier: 1),
            sessionId: "s1",
            outcome: .success
        )
        let line = try EventEncoder.jsonLine(from: event)
        XCTAssertTrue(line.contains("\"type\":\"appActivated\""))
        XCTAssertTrue(line.contains("com.apple.finder"))
        XCTAssertTrue(line.contains("\"outcome\":\"success\""))
    }

    private func advance(_ seconds: TimeInterval) {
        clock = clock.addingTimeInterval(seconds)
    }
}
