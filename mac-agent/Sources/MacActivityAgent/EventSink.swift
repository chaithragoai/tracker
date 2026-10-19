import ActivityCore
import Foundation

protocol EventSink: AnyObject {
    func emit(_ event: ActivityEvent)
}

/// Appends one JSON object per line to a file and mirrors to stdout when verbose.
final class JSONLFileSink: EventSink {
    private let url: URL
    private let verbose: Bool
    private let queue = DispatchQueue(label: "mac.activity.agent.jsonl")

    init(url: URL, verbose: Bool) {
        self.url = url
        self.verbose = verbose
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
    }

    func emit(_ event: ActivityEvent) {
        queue.async {
            do {
                let line = try EventEncoder.jsonLine(from: event) + "\n"
                if let handle = try? FileHandle(forWritingTo: self.url) {
                    defer { try? handle.close() }
                    try handle.seekToEnd()
                    if let data = line.data(using: .utf8) {
                        try handle.write(contentsOf: data)
                    }
                }
                if self.verbose {
                    FileHandle.standardOutput.write(Data(line.utf8))
                }
            } catch {
                fputs("event write error: \(error)\n", stderr)
            }
        }
    }
}

/// POSTs events to the local/central server with device credentials.
final class HTTPEventSink: EventSink {
    private let endpoint: URL
    private let session: URLSession
    private let queue = DispatchQueue(label: "mac.activity.agent.http")
    private let deviceId: String
    private let deviceSecret: String

    init(
        baseURL: URL,
        deviceId: String,
        deviceSecret: String,
        session: URLSession = .shared
    ) {
        self.endpoint = baseURL.appendingPathComponent("api/events")
        self.session = session
        self.deviceId = deviceId
        self.deviceSecret = deviceSecret
    }

    func emit(_ event: ActivityEvent) {
        queue.async {
            do {
                var request = URLRequest(url: self.endpoint)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue(
                    "Device \(self.deviceId) \(self.deviceSecret)",
                    forHTTPHeaderField: "Authorization"
                )
                request.timeoutInterval = 3
                request.httpBody = try EventEncoder.jsonData(from: event)
                let task = self.session.dataTask(with: request) { _, response, error in
                    if let error {
                        fputs("http sink error: \(error.localizedDescription)\n", stderr)
                        return
                    }
                    if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                        fputs("http sink status: \(http.statusCode)\n", stderr)
                    }
                }
                task.resume()
            } catch {
                fputs("http sink encode error: \(error)\n", stderr)
            }
        }
    }
}

final class MultiplexSink: EventSink {
    private let sinks: [EventSink]

    init(_ sinks: [EventSink]) {
        self.sinks = sinks
    }

    func emit(_ event: ActivityEvent) {
        for sink in sinks {
            sink.emit(event)
        }
    }
}

/// Loads device credentials from Application Support (written by enroll-local-device / server auto-provision).
struct DeviceCredentialsFile: Decodable {
    let device_id: String
    let device_secret: String
    let server_url: String?
    let display_name: String?
}

enum DeviceCredentialLoader {
    static func load(from supportDir: URL) -> DeviceCredentialsFile? {
        if let envId = ProcessInfo.processInfo.environment["TRACKER_DEVICE_ID"],
           let envSecret = ProcessInfo.processInfo.environment["TRACKER_DEVICE_SECRET"],
           !envId.isEmpty, !envSecret.isEmpty {
            return DeviceCredentialsFile(
                device_id: envId,
                device_secret: envSecret,
                server_url: ProcessInfo.processInfo.environment["TRACKER_SERVER_URL"],
                display_name: nil
            )
        }
        let url = supportDir.appendingPathComponent("device-credentials.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(DeviceCredentialsFile.self, from: data)
    }
}

/// Authenticated reachability heartbeat — updates last_check_in_at only (not activity).
final class DeviceCheckInClient {
    private let endpoint: URL
    private let deviceId: String
    private let deviceSecret: String
    private let session: URLSession
    private var timer: Timer?

    init(baseURL: URL, deviceId: String, deviceSecret: String, session: URLSession = .shared) {
        self.endpoint = baseURL.appendingPathComponent("api/devices/check-in")
        self.deviceId = deviceId
        self.deviceSecret = deviceSecret
        self.session = session
    }

    func start(interval: TimeInterval = 60) {
        stop()
        sendOnce()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.sendOnce()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func sendOnce() {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Device \(deviceId) \(deviceSecret)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 3
        request.httpBody = Data(#"{"client":"mac-agent"}"#.utf8)
        session.dataTask(with: request) { _, response, error in
            if let error {
                fputs("check-in error: \(error.localizedDescription)\n", stderr)
                return
            }
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                fputs("check-in status: \(http.statusCode)\n", stderr)
            }
        }.resume()
    }
}
