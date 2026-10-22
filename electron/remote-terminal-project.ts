import type { ProjectConfig } from "./types";
import type { Preset } from "./presets";
import { oneAtATime } from "./keyed-queue";

export interface RemoteTerminalProjectDeps {
  updateProjectFromLatest: (slug: string, update: (project: ProjectConfig) => ProjectConfig) => Promise<ProjectConfig>;
  openProject: (directory: string) => Promise<void>;
  broadcastProjects: () => void;
  stopTerminal: (terminalId: string) => Promise<void>;
}

/** Persist a host-owned remote terminal as a normal project tab only after its
 * PTY is live. Mutations use the config store's serialized latest-project path. */
export function createRemoteTerminalOnSpawned(deps: RemoteTerminalProjectDeps): (
  terminalId: string,
  selectedProject: ProjectConfig,
  preset: Preset,
) => Promise<void> {
  const serializeByProject = oneAtATime();
  return (terminalId, selectedProject, preset) => serializeByProject(selectedProject.slug, async () => {
    let tabAdded = false;
    try {
      const project = await deps.updateProjectFromLatest(selectedProject.slug, (current) => {
        if (current.remote) throw new Error("The selected host project is unavailable.");
        const baseName = `Remote ${preset.name}`;
        const used = new Set(current.tabs.map((tab) => tab.name));
        let name = baseName;
        for (let suffix = 2; used.has(name); suffix += 1) name = `${baseName} ${suffix}`;
        return { ...current, tabs: [...current.tabs, { id: terminalId, presetId: preset.id, name }] };
      });
      tabAdded = true;
      await deps.openProject(project.directory);
      deps.broadcastProjects();
    } catch (error) {
      if (tabAdded) {
        try {
          await deps.updateProjectFromLatest(selectedProject.slug, (current) => {
            if (current.remote) throw new Error("The selected host project is unavailable.");
            return { ...current, tabs: current.tabs.filter((tab) => tab.id !== terminalId) };
          });
        } catch { /* Preserve the original failure; the terminal is stopped below. */ }
      }
      await deps.stopTerminal(terminalId).catch(() => {});
      throw error;
    }
  });
}
