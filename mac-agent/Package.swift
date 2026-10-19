// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacActivityAgent",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "MacActivityAgent", targets: ["MacActivityAgent"]),
        .executable(name: "ActivityCoreTestRunner", targets: ["ActivityCoreTestRunner"]),
        .library(name: "ActivityCore", targets: ["ActivityCore"]),
    ],
    targets: [
        .target(name: "ActivityCore"),
        .executableTarget(
            name: "MacActivityAgent",
            dependencies: ["ActivityCore"]
        ),
        // Standalone runner: full Xcode (XCTest) is not installed on this machine.
        .executableTarget(
            name: "ActivityCoreTestRunner",
            dependencies: ["ActivityCore"]
        ),
        .testTarget(
            name: "ActivityCoreTests",
            dependencies: ["ActivityCore"]
        ),
    ]
)
