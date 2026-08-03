import Foundation

/// Client for the PTY host unix socket (newline-delimited JSON).
///
/// POSIX socket + a dedicated reader thread rather than Network.framework:
/// the protocol is line-oriented and tiny, and NWConnection's unix-socket
/// support has enough sharp edges (no half-close semantics, opaque errors)
/// that the syscalls are the simpler dependency.
///
/// Thread model: `request` is async and safe from any thread; responses are
/// resolved by the reader thread. `onEvent` is always delivered on the main
/// queue (it feeds UI).
public final class PtyHostClient: @unchecked Sendable {
    private let socketPath: String
    private var fd: Int32 = -1
    private let stateLock = NSLock()
    private var nextRequestId = 1
    private var pending: [Int: CheckedContinuation<Any?, Error>] = [:]
    private var readerThread: Thread?
    private var closed = false

    /// Delivered on the main queue.
    public var onEvent: ((PtyEvent) -> Void)?
    /// Delivered on the main queue when the socket drops (host exit/restart).
    public var onDisconnect: (() -> Void)?

    public init(socketPath: String) {
        self.socketPath = socketPath
    }

    deinit { close() }

    // MARK: - Connection

    public func connect() throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw PtyHostError.connectFailed("socket(): errno \(errno)")
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            Darwin.close(fd)
            throw PtyHostError.connectFailed("socket path too long (\(pathBytes.count) bytes): \(socketPath)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, size)
            }
        }
        guard result == 0 else {
            let err = errno
            Darwin.close(fd)
            throw PtyHostError.connectFailed("connect(): errno \(err) (\(String(cString: strerror(err))))")
        }
        // The host can go away between our write and its read; without this a
        // write to the dead socket kills the whole app with SIGPIPE.
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

        self.fd = fd
        let thread = Thread { [weak self] in self?.readLoop(fd: fd) }
        thread.name = "aya.pty-host-reader"
        thread.start()
        readerThread = thread
    }

    public func close() {
        stateLock.lock()
        let wasClosed = closed
        closed = true
        let fd = self.fd
        self.fd = -1
        let waiters = pending
        pending.removeAll()
        stateLock.unlock()
        if wasClosed { return }
        if fd >= 0 { Darwin.close(fd) }
        for (_, continuation) in waiters {
            continuation.resume(throwing: PtyHostError.disconnected)
        }
    }

    // MARK: - Requests

    /// Send a request and await the host's `{id, ok, ...}` response.
    /// `extra` carries the request-specific fields next to `id` + `type`.
    @discardableResult
    public func request(type: String, extra: [String: Any] = [:]) async throws -> Any? {
        stateLock.lock()
        guard fd >= 0, !closed else {
            stateLock.unlock()
            throw PtyHostError.notConnected
        }
        let id = nextRequestId
        nextRequestId += 1
        stateLock.unlock()

        var object: [String: Any] = ["id": id, "type": type]
        for (key, value) in extra { object[key] = value }
        let payload = try JSONSerialization.data(withJSONObject: object)

        return try await withCheckedThrowingContinuation { continuation in
            stateLock.lock()
            pending[id] = continuation
            let fd = self.fd
            stateLock.unlock()
            var line = payload
            line.append(0x0A)
            let ok = line.withUnsafeBytes { raw -> Bool in
                var sent = 0
                while sent < raw.count {
                    let n = Darwin.send(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent, 0)
                    if n <= 0 { return false }
                    sent += n
                }
                return true
            }
            if !ok {
                stateLock.lock()
                let waiter = pending.removeValue(forKey: id)
                stateLock.unlock()
                waiter?.resume(throwing: PtyHostError.disconnected)
            }
        }
    }

    // MARK: - Typed helpers

    public func spawn(_ req: SpawnRequest) async throws {
        let data = try JSONEncoder().encode(req)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        try await request(type: "spawn", extra: ["req": object])
    }

    public func write(ptyId: String, data: String) async throws {
        try await request(type: "write", extra: ["ptyId": ptyId, "data": data])
    }

    public func resize(ptyId: String, cols: Int, rows: Int) async throws {
        try await request(type: "resize", extra: ["ptyId": ptyId, "cols": cols, "rows": rows])
    }

    public func kill(ptyId: String) async throws {
        try await request(type: "kill", extra: ["ptyId": ptyId])
    }

    public func buffer(ptyId: String) async throws -> String {
        try await request(type: "buffer", extra: ["ptyId": ptyId]) as? String ?? ""
    }

    public func version() async throws -> HostVersion {
        let result = try await request(type: "version") as? [String: Any] ?? [:]
        return HostVersion(
            version: result["version"] as? String ?? "unknown",
            ptyCount: result["ptyCount"] as? Int ?? 0,
            pid: result["pid"] as? Int ?? 0
        )
    }

    // MARK: - Reader

    private func readLoop(fd: Int32) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = chunk.withUnsafeMutableBytes { raw in
                Darwin.recv(fd, raw.baseAddress!, raw.count, 0)
            }
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<newline)
                buffer.removeSubrange(buffer.startIndex...newline)
                handleLine(line)
            }
        }
        close()
        DispatchQueue.main.async { [weak self] in self?.onDisconnect?() }
    }

    private func handleLine(_ line: Data) {
        guard !line.isEmpty,
              let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
        else { return }

        if object["type"] as? String == "event" {
            guard let eventObject = object["event"] as? [String: Any],
                  let event = PtyEvent.parse(eventObject) else { return }
            DispatchQueue.main.async { [weak self] in self?.onEvent?(event) }
            return
        }

        guard let id = object["id"] as? Int else { return }
        stateLock.lock()
        let waiter = pending.removeValue(forKey: id)
        stateLock.unlock()
        guard let waiter else { return }
        if object["ok"] as? Bool == true {
            waiter.resume(returning: object["result"])
        } else {
            waiter.resume(throwing: PtyHostError.requestFailed(object["error"] as? String ?? "unknown error"))
        }
    }
}
