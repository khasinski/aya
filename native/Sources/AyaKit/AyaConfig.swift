import Foundation

/// Read-only view of Aya's on-disk config ($AYA_HOME). The Electron app owns
/// these files; the native experiment only reads them (v0 contract - see
/// docs/pty-host-protocol.md "Related on-disk state").
public struct AyaEnvironment {
    public let home: URL

    /// `AYA_NATIVE_HOME` from the environment, else `~/.aya-native`. Plain
    /// `AYA_HOME` is IGNORED on purpose: shells inside Aya terminals export it
    /// pointing at the live `~/.aya`, and inheriting it would aim the
    /// experiment at real sessions (it happened; see `isLiveUserHome`).
    public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        if let override = environment["AYA_NATIVE_HOME"], !override.isEmpty {
            home = URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        } else {
            home = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".aya-native")
        }
    }

    /// True when pointed at the real `~/.aya`. The v0 app refuses to start in
    /// that case - the experiment must never share the live backend.
    public var isLiveUserHome: Bool {
        home.standardizedFileURL.path ==
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".aya").standardizedFileURL.path
    }

    public var socketPath: String { home.appendingPathComponent("pty-host.sock").path }
    public var projectsDir: URL { home.appendingPathComponent("projects") }
    public var presetsFile: URL { home.appendingPathComponent("presets.json") }
}

public struct AyaTab: Decodable, Identifiable, Hashable {
    public let id: String
    public let presetId: String
    public let name: String
}

public struct AyaProject: Decodable, Identifiable {
    public let name: String
    public let directory: String
    public let tabs: [AyaTab]
    public var id: String { name }
}

public struct AyaPreset: Decodable {
    public let id: String
    public let name: String
    public let command: String
    public let icon: String?
    public let color: String?
}

public enum AyaConfig {
    public static func loadProjects(_ env: AyaEnvironment) -> [AyaProject] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: env.projectsDir, includingPropertiesForKeys: nil
        )) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(AyaProject.self, from: data)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Preset id -> preset. Missing file or unknown ids fall back to a plain
    /// login shell, so the app degrades to "a terminal" rather than erroring.
    public static func loadPresets(_ env: AyaEnvironment) -> [String: AyaPreset] {
        struct PresetsFile: Decodable { let presets: [AyaPreset] }
        var result: [String: AyaPreset] = [:]
        if let data = try? Data(contentsOf: env.presetsFile),
           let file = try? JSONDecoder().decode(PresetsFile.self, from: data) {
            for preset in file.presets { result[preset.id] = preset }
        }
        if result["shell"] == nil {
            result["shell"] = AyaPreset(id: "shell", name: "Shell", command: "$SHELL", icon: "$", color: nil)
        }
        return result
    }

    public static func command(for tab: AyaTab, presets: [String: AyaPreset]) -> String {
        presets[tab.presetId]?.command ?? "$SHELL"
    }
}
