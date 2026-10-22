import type { ProjectConfig } from "./types";
import type { RemotePtySessions } from "./remote-pty-sessions";

export interface RemoteSessionRestoreDeps {
  sessions: RemotePtySessions;
  listProjects: () => Promise<ProjectConfig[]>;
  getPid: (terminalId: string) => Promise<number | null | undefined>;
  getOutput: (terminalId: string) => Promise<{ output: string; endOffset: number } | null>;
  processStartIdentity: (pid: number) => string | null;
  isAlive: (pid: number) => boolean;
  attach: () => void;
}

/** Rebuild remote stream state from project tabs and the PTY host that remains
 * alive when only Aya's main process is replaced. Transcript bytes stay in the
 * host's bounded output ring, not in project settings or a second disk log. */
export async function restoreRemoteTerminalSessions(deps: RemoteSessionRestoreDeps): Promise<number> {
  const projects = await deps.listProjects();
  const entries = projects.flatMap(project => project.tabs
    .filter(tab => tab.remoteTerminal === true || tab.name.startsWith("Remote "))
    .map(tab => ({ project, tab })));
  const snapshots = await Promise.all(entries.map(async ({ project, tab }) => {
    const [pid, output] = await Promise.all([
      deps.getPid(tab.id).catch(() => undefined),
      deps.getOutput(tab.id).catch(() => null),
    ]);
    const startIdentity = typeof pid === "number" ? deps.processStartIdentity(pid) : null;
    let running: boolean | null = typeof pid === "number" ? startIdentity ? true : null : pid === null ? false : null;
    const processIdentity = typeof pid === "number" && startIdentity ? { pid, startIdentity } : undefined;
    if (typeof pid === "number" && startIdentity) {
      if (!deps.isAlive(pid) || deps.processStartIdentity(pid) !== startIdentity) running = false;
    }
    return {
      project: project.slug,
      terminalId: tab.id,
      preset: tab.presetId,
      output: output?.output ?? "",
      endOffset: output?.endOffset ?? 0,
      running,
      ...(processIdentity ? { processIdentity } : {}),
    };
  }));
  for (const snapshot of snapshots) deps.sessions.restoreTerminal(snapshot);

  // Subscribe after the first consistent snapshot, then take a second one to
  // cover output produced between that snapshot and subscription. streamOffset
  // makes events racing either read idempotent.
  deps.attach();
  await Promise.all(entries.map(async ({ tab }) => {
    const output = await deps.getOutput(tab.id).catch(() => null);
    if (output) deps.sessions.syncRestoredOutput(tab.id, output.output, output.endOffset);
  }));
  return entries.length;
}
