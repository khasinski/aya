import AppKit
import AyaKit
import SwiftTerm

/// One tab's terminal: a SwiftTerm view wired to the PTY host.
///
/// Attach flow mirrors the Electron frontend's boot semantics: try
/// `attachOnly` first (live session -> attach + replay), and only on the
/// host's `no-session` verdict spawn a fresh process. Against a shared host
/// this means the native app joins existing sessions instead of stealing or
/// duplicating them.
final class TerminalPane: NSView {
    let terminalView = TerminalView()
    private let tab: AyaTab
    private let project: AyaProject
    private let client: PtyHostClient
    private var command = "$SHELL"
    private var spawnedFresh = false
    private var exited = false

    init(tab: AyaTab, project: AyaProject, client: PtyHostClient) {
        self.tab = tab
        self.project = project
        self.client = client
        super.init(frame: .zero)

        terminalView.terminalDelegate = self
        terminalView.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminalView.nativeBackgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1)
        terminalView.nativeForegroundColor = NSColor(calibratedWhite: 0.92, alpha: 1)
        terminalView.autoresizingMask = [.width, .height]
        addSubview(terminalView)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        terminalView.frame = bounds
    }

    func attachOrSpawn(command: String) {
        self.command = command
        send(attachOnly: true)
    }

    private func send(attachOnly: Bool) {
        let terminal = terminalView.getTerminal()
        let req = SpawnRequest(
            ptyId: tab.id,
            projectSlug: project.name,
            presetId: tab.presetId,
            command: command,
            cwd: project.directory,
            cols: max(terminal.cols, 20),
            rows: max(terminal.rows, 5),
            attachOnly: attachOnly ? true : nil
        )
        Task { @MainActor in
            do {
                try await client.spawn(req)
            } catch {
                feedNotice("cannot spawn: \(error.localizedDescription)")
            }
        }
    }

    func handle(_ event: PtyEvent) {
        switch event {
        case .data(_, let chunk, _):
            terminalView.feed(text: chunk)
        case .exit(_, let code):
            exited = true
            feedNotice("process exited with code \(code) — press ⏎ to restart")
        case .noSession:
            // Fresh id on this host: start the real process exactly once.
            guard !spawnedFresh else { return }
            spawnedFresh = true
            send(attachOnly: false)
        case .spawnFailed(_, _, let detail):
            exited = true
            feedNotice("spawn failed: \(detail)")
        }
    }

    private func feedNotice(_ text: String) {
        terminalView.feed(text: "\r\n\u{1b}[2m[\(text)]\u{1b}[0m\r\n")
    }

    private func restartIfExited() -> Bool {
        guard exited else { return false }
        exited = false
        send(attachOnly: false)
        return true
    }
}

extension TerminalPane: TerminalViewDelegate {
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let text = String(decoding: data, as: UTF8.self)
        if text == "\r" && restartIfExited() { return }
        Task { @MainActor in
            try? await client.write(ptyId: tab.id, data: text)
        }
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard newCols > 0, newRows > 0 else { return }
        Task { @MainActor in
            try? await client.resize(ptyId: tab.id, cols: newCols, rows: newRows)
        }
    }

    func setTerminalTitle(source: TerminalView, title: String) {
        window?.title = title.isEmpty ? "\(project.name) — \(tab.name)" : title
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func scrolled(source: TerminalView, position: Double) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
    }

    func bell(source: TerminalView) { NSSound.beep() }

    func clipboardCopy(source: TerminalView, content: Data) {
        if let text = String(data: content, encoding: .utf8) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
