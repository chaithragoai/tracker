import Foundation

/// Encodes events as JSON lines for files or HTTP bodies.
public enum EventEncoder {
    public static func jsonObject(from event: ActivityEvent) -> [String: Any] {
        var obj: [String: Any] = [
            "id": event.id,
            "timestamp": ISO8601Codec.string(from: event.timestamp),
            "type": event.type.rawValue,
            "outcome": event.outcome.rawValue,
            "metadata": event.metadata,
        ]
        if let app = event.app {
            var appObj: [String: Any] = ["name": app.name]
            if let bid = app.bundleIdentifier { appObj["bundleIdentifier"] = bid }
            if let pid = app.processIdentifier { appObj["processIdentifier"] = pid }
            obj["app"] = appObj
        }
        if let sid = event.sessionId { obj["sessionId"] = sid }
        if let dur = event.durationSeconds { obj["durationSeconds"] = dur }
        return obj
    }

    public static func jsonData(from event: ActivityEvent) throws -> Data {
        try JSONSerialization.data(withJSONObject: jsonObject(from: event), options: [.sortedKeys])
    }

    public static func jsonLine(from event: ActivityEvent) throws -> String {
        let data = try jsonData(from: event)
        guard let line = String(data: data, encoding: .utf8) else {
            throw EncodingError.invalidUTF8
        }
        return line
    }

    public enum EncodingError: Error {
        case invalidUTF8
    }
}
