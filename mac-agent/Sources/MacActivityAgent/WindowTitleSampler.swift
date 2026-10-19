import AppKit
import ActivityCore
import CoreGraphics
import Foundation

/// Privacy-safe window title sampling for work-context signals.
/// Uses CGWindowList (Screen Recording may be required for titles on newer macOS).
/// Never captures keystrokes, passwords, or screenshots.
enum WindowTitleSampler {
    /// Apps where window titles often encode project/file context.
    private static let interestingBundles: Set<String> = [
        "com.todesktop.230313mzl4w4u92", // Cursor
        "com.microsoft.VSCode",
        "com.apple.dt.Xcode",
        "com.googlecode.iterm2",
        "com.apple.Terminal",
        "dev.warp.Warp-Stable",
        "com.google.Chrome",
        "company.thebrowser.Browser",
        "com.apple.Safari",
    ]

    private static let interestingNames = [
        "cursor", "code", "xcode", "terminal", "iterm", "warp", "chrome", "safari", "arc",
    ]

    static func isInteresting(_ app: AppIdentity) -> Bool {
        if let bid = app.bundleIdentifier, interestingBundles.contains(bid) { return true }
        let name = app.name.lowercased()
        return interestingNames.contains { name.contains($0) }
    }

    /// Best-effort front window title for the given app process.
    static func title(for app: AppIdentity) -> String? {
        guard isInteresting(app) else { return nil }
        guard let pid = app.processIdentifier else { return nil }

        let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
        guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        var best: String?
        var bestArea: Int = 0
        for win in info {
            let ownerPid = win[kCGWindowOwnerPID as String] as? pid_t
            guard ownerPid == pid else { continue }
            let layer = win[kCGWindowLayer as String] as? Int ?? 0
            guard layer == 0 else { continue }
            let name = (win[kCGWindowName as String] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !name.isEmpty else { continue }
            let bounds = win[kCGWindowBounds as String] as? [String: Any]
            let w = Int(bounds?["Width"] as? Double ?? 0)
            let h = Int(bounds?["Height"] as? Double ?? 0)
            let area = max(0, w) * max(0, h)
            if area >= bestArea {
                bestArea = area
                best = name
            }
        }
        return best.map(sanitize)
    }

    /// Strip home-directory paths; keep basenames and workspace labels.
    static func sanitize(_ raw: String) -> String {
        var s = raw
        // Collapse /Users/<name>/... → ~/<basename chain shortened>
        if let regex = try? NSRegularExpression(pattern: #"/Users/[^/]+/"#) {
            s = regex.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "~/")
        }
        // Drop query-like secrets
        if let regex = try? NSRegularExpression(pattern: #"(token|password|secret|api[_-]?key)=[^&\s]+"#, options: .caseInsensitive) {
            s = regex.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "$1=…")
        }
        if s.count > 160 {
            s = String(s.prefix(157)) + "…"
        }
        return s
    }

    /// Extract a coarse project/workspace hint from common IDE title patterns.
    static func projectHint(from title: String) -> String? {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        // Cursor / VS Code: "file — workspace — Cursor" or "file - workspace - Visual Studio Code"
        let seps = [" — ", " – ", " - "]
        for sep in seps {
            let parts = t.components(separatedBy: sep).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if parts.count >= 2 {
                // Prefer middle segment as workspace when 3+ parts
                let candidate = parts.count >= 3 ? parts[parts.count - 2] : parts[0]
                let skip = ["cursor", "code", "visual studio code", "xcode", "terminal", "chrome", "safari"]
                if !skip.contains(candidate.lowercased()) {
                    return String(candidate.prefix(80))
                }
            }
        }
        return nil
    }
}
