import AppKit
import AyaKit

/// Owns the host connection, config, and the warm pool of terminal panes.
/// One pane per tab id, kept alive across sidebar switches - native views are
/// cheap, so the whole "hidden pool" machinery of the Electron frontend
/// collapses into a dictionary.
final class SessionStore {
    let env: AyaEnvironment
    private(set) var projects: [AyaProject] = []
    private var presets: [String: AyaPreset] = [:]
    private let client: PtyHostClient
    private var panes: [String: TerminalPane] = [:]
    var onStatus: ((String) -> Void)?

    init(env: AyaEnvironment) {
        self.env = env
        self.client = PtyHostClient(socketPath: env.socketPath)
    }

    func start() {
        projects = AyaConfig.loadProjects(env)
        presets = AyaConfig.loadPresets(env)

        client.onEvent = { [weak self] event in self?.route(event) }
        client.onDisconnect = { [weak self] in
            self?.onStatus?("host connection lost — restart via native/run-dev.sh")
        }
        do {
            try client.connect()
            Task { @MainActor in
                if let version = try? await self.client.version() {
                    self.onStatus?(
                        "host v\(version.version) pid \(version.pid) · \(version.ptyCount) ptys · AYA_HOME \(self.env.home.path)"
                    )
                }
            }
        } catch {
            onStatus?("cannot connect (\(error.localizedDescription)) — start the host with native/run-dev.sh")
        }
    }

    func pane(for tab: AyaTab, in project: AyaProject) -> TerminalPane {
        if let existing = panes[tab.id] { return existing }
        let pane = TerminalPane(tab: tab, project: project, client: client)
        panes[tab.id] = pane
        pane.attachOrSpawn(command: AyaConfig.command(for: tab, presets: presets))
        return pane
    }

    private func route(_ event: PtyEvent) {
        panes[event.ptyId]?.handle(event)
    }
}
