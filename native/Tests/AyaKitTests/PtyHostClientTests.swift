import XCTest
@testable import AyaKit

/// Integration test against a REAL pty host (plain node, isolated AYA_HOME).
/// Mirrors tests/pty-host-integration.test.mjs on the Electron side: spawn a
/// short-lived command, expect data + exit events, then verify the attachOnly
/// no-session verdict for an unknown id.
final class PtyHostClientTests: XCTestCase {
    private var hostProcess: Process?
    private var home: String!

    /// Repo root, resolved from this file's location (native/Tests/AyaKitTests).
    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // AyaKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // native
            .deletingLastPathComponent() // repo root
    }

    override func setUpWithError() throws {
        let hostScript = repoRoot.appendingPathComponent("dist-electron/pty-host.js")
        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: hostScript.path),
            "dist-electron/pty-host.js missing — run `npm run build:electron` first"
        )

        // Short path: unix socket paths cap at ~104 bytes.
        home = "/tmp/aya-swift-test-\(UInt32.random(in: 1000...9999))"
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", hostScript.path]
        var env = ProcessInfo.processInfo.environment
        env["AYA_HOME"] = home
        env.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        process.environment = env
        try process.run()
        hostProcess = process

        // Wait for the socket to appear.
        let socket = "\(home!)/pty-host.sock"
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: socket) { return }
            usleep(50_000)
        }
        XCTFail("pty host socket never appeared at \(socket)")
    }

    override func tearDownWithError() throws {
        if let client = try? connectedClient() {
            _ = try? awaitTask { try await client.request(type: "shutdown") }
            client.close()
        }
        hostProcess?.terminate()
        if let home { try? FileManager.default.removeItem(atPath: home) }
    }

    private func connectedClient() throws -> PtyHostClient {
        let client = PtyHostClient(socketPath: "\(home!)/pty-host.sock")
        try client.connect()
        return client
    }

    private func awaitTask<T>(_ body: @escaping () async throws -> T) throws -> T {
        let expectation = expectation(description: "async")
        var result: Result<T, Error>!
        Task {
            do { result = .success(try await body()) } catch { result = .failure(error) }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 15)
        return try result.get()
    }

    func testVersionSpawnDataExitAndNoSession() throws {
        let client = try connectedClient()
        defer { client.close() }

        var chunks: [String] = []
        var exitCode: Int?
        var noSessionIds: [String] = []
        let sawMarker = expectation(description: "marker output")
        let sawExit = expectation(description: "exit event")
        let sawNoSession = expectation(description: "no-session verdict")

        client.onEvent = { event in
            switch event {
            case .data(_, let chunk, _):
                chunks.append(chunk)
                if chunks.joined().contains("AYA_SWIFT_OK") { sawMarker.fulfill() }
            case .exit(_, let code):
                exitCode = code
                sawExit.fulfill()
            case .noSession(let id):
                noSessionIds.append(id)
                sawNoSession.fulfill()
            case .spawnFailed(_, _, let detail):
                XCTFail("unexpected spawn failure: \(detail)")
            }
        }

        let version = try awaitTask { try await client.version() }
        XCTAssertGreaterThan(version.pid, 0)

        // attachOnly for an id the host has never seen -> no-session, no process.
        try awaitTask {
            try await client.spawn(SpawnRequest(
                ptyId: "ghost-tab", command: "true", cwd: "/tmp",
                cols: 80, rows: 24, attachOnly: true
            ))
        }
        wait(for: [sawNoSession], timeout: 10)
        XCTAssertEqual(noSessionIds, ["ghost-tab"])

        // Real spawn: expect our marker in the data stream and a clean exit.
        try awaitTask {
            try await client.spawn(SpawnRequest(
                ptyId: "swift-test-tab", command: "echo AYA_SWIFT_OK",
                cwd: "/tmp", cols: 80, rows: 24
            ))
        }
        wait(for: [sawMarker, sawExit], timeout: 12)
        XCTAssertEqual(exitCode, 0)
    }
}
