import Foundation

/// Wire types for the PTY host protocol (docs/pty-host-protocol.md).
/// Mirrors electron/pty-host-protocol.ts + electron/types.ts.

public struct SpawnRequest: Encodable {
    public var ptyId: String
    public var projectSlug: String?
    public var presetId: String?
    public var command: String
    public var cwd: String
    public var cols: Int
    public var rows: Int
    public var attachOnly: Bool?

    public init(
        ptyId: String,
        projectSlug: String? = nil,
        presetId: String? = nil,
        command: String,
        cwd: String,
        cols: Int,
        rows: Int,
        attachOnly: Bool? = nil
    ) {
        self.ptyId = ptyId
        self.projectSlug = projectSlug
        self.presetId = presetId
        self.command = command
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.attachOnly = attachOnly
    }
}

public enum PtyEvent {
    case data(ptyId: String, chunk: String, replay: Bool)
    case exit(ptyId: String, exitCode: Int)
    case spawnFailed(ptyId: String, reason: String, detail: String)
    case noSession(ptyId: String)

    public var ptyId: String {
        switch self {
        case .data(let id, _, _), .exit(let id, _),
             .spawnFailed(let id, _, _), .noSession(let id):
            return id
        }
    }

    static func parse(_ object: [String: Any]) -> PtyEvent? {
        guard let type = object["type"] as? String,
              let ptyId = object["ptyId"] as? String else { return nil }
        switch type {
        case "data":
            guard let chunk = object["chunk"] as? String else { return nil }
            return .data(ptyId: ptyId, chunk: chunk, replay: object["replay"] as? Bool ?? false)
        case "exit":
            return .exit(ptyId: ptyId, exitCode: object["exitCode"] as? Int ?? -1)
        case "spawn-failed":
            return .spawnFailed(
                ptyId: ptyId,
                reason: object["reason"] as? String ?? "unknown",
                detail: object["detail"] as? String ?? ""
            )
        case "no-session":
            return .noSession(ptyId: ptyId)
        default:
            // Forward-compatibility: unknown event types are dropped, never fatal.
            return nil
        }
    }
}

public struct HostVersion {
    public let version: String
    public let ptyCount: Int
    public let pid: Int
}

public enum PtyHostError: Error, LocalizedError {
    case notConnected
    case connectFailed(String)
    case requestFailed(String)
    case disconnected

    public var errorDescription: String? {
        switch self {
        case .notConnected: return "not connected to the PTY host"
        case .connectFailed(let detail): return "cannot connect to the PTY host: \(detail)"
        case .requestFailed(let message): return "host rejected the request: \(message)"
        case .disconnected: return "connection to the PTY host was lost"
        }
    }
}
