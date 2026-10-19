import ActivityCore
import Foundation

let supportDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/MacActivityTracker", isDirectory: true)
try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)

let eventsURL = supportDir.appendingPathComponent("events.jsonl")
let stateURL = supportDir.appendingPathComponent("agent-state.json")

var verbose = true
var postToServer = true
var serverURL = URL(string: "http://127.0.0.1:8787")!
var runSeconds: Double? = nil

var args = Array(CommandLine.arguments.dropFirst())
while let arg = args.first {
    args.removeFirst()
    switch arg {
    case "--quiet":
        verbose = false
    case "--no-http":
        postToServer = false
    case "--server":
        if let value = args.first, let url = URL(string: value) {
            serverURL = url
            args.removeFirst()
        }
    case "--run-seconds":
        if let value = args.first, let seconds = Double(value) {
            runSeconds = seconds
            args.removeFirst()
        }
    case "--help", "-h":
        print("""
        MacActivityAgent — tracks the frontmost macOS application.

        Options:
          --quiet           Do not mirror events to stdout
          --no-http         Do not POST events to the local server
          --server URL      Local server base URL (default http://127.0.0.1:8787)
          --run-seconds N   Exit after N seconds (for automated tests)

        Device auth:
          Reads ~/Library/Application Support/MacActivityTracker/device-credentials.json
          or env TRACKER_DEVICE_ID + TRACKER_DEVICE_SECRET
          Enroll with: scripts/enroll-local-device.sh

        Events file: \(eventsURL.path)
        """)
        exit(0)
    default:
        fputs("Unknown argument: \(arg)\n", stderr)
        exit(2)
    }
}

var sinks: [EventSink] = [JSONLFileSink(url: eventsURL, verbose: verbose)]
var checkInClient: DeviceCheckInClient?
if postToServer {
    guard let creds = DeviceCredentialLoader.load(from: supportDir) else {
        fputs("""
        ERROR: Device credentials not found.
        HTTP posting requires an enrolled device.
        Run: scripts/enroll-local-device.sh
        Or set TRACKER_DEVICE_ID and TRACKER_DEVICE_SECRET.
        (Use --no-http to record JSONL only.)

        """, stderr)
        exit(3)
    }
    if let urlStr = creds.server_url, let url = URL(string: urlStr) {
        serverURL = url
    }
    sinks.append(HTTPEventSink(
        baseURL: serverURL,
        deviceId: creds.device_id,
        deviceSecret: creds.device_secret
    ))
    checkInClient = DeviceCheckInClient(
        baseURL: serverURL,
        deviceId: creds.device_id,
        deviceSecret: creds.device_secret
    )
    fputs("HTTP sink: device \(creds.device_id) → \(serverURL.absoluteString)\n", stderr)
}
let sink = MultiplexSink(sinks)
let agent = AgentController(sink: sink, stateURL: stateURL)
agent.start()
checkInClient?.start(interval: 60)

// Interactive commands on stdin (status / pause / resume / stop).
FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
    for line in text.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) }) {
        switch line.lowercased() {
        case "status", "s":
            fputs(agent.statusLine + "\n", stderr)
        case "pause", "p":
            agent.pause()
        case "resume", "r":
            agent.resume()
        case "stop", "quit", "q", "exit":
            agent.stop()
            exit(0)
        case "":
            break
        default:
            fputs("Unknown command. Use: status | pause | resume | stop\n", stderr)
        }
    }
}

if let seconds = runSeconds {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
        agent.stop()
        exit(0)
    }
}

RunLoop.main.run()
