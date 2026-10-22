import type { ProjectConfig } from "./types";
import type { RemotePtySessions } from "./remote-pty-sessions";
import { MAX_PTY_PANES } from "./pty-pane-limits";

const RESTORE_CONCURRENCY = 4;

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
  const seen = new Set<string>();
  const uniqueEntries = projects.flatMap(project => project.tabs
    .filter(tab => tab.remoteTerminal === true || tab.name.startsWith("Remote "))
    .map(tab => ({ project, tab })))
    .filter(({ tab }) => {
      if (seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    });
  // The host's pane limit is also the maximum useful restore set. Deduping and
  // capping before probing keeps stale saved tabs from creating an unbounded
  // registry or a burst of startup host requests.
  const entries = uniqueEntries.slice(0, MAX_PTY_PANES);
  const snapshots = await mapConcurrent(entries, RESTORE_CONCURRENCY, async ({ project, tab }) => {
    const pid = await deps.getPid(tab.id).catch(() => undefined);
    const output = await deps.getOutput(tab.id).catch(() => null);
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
  });
  for (const snapshot of snapshots) deps.sessions.restoreTerminal(snapshot);

  // Subscribe after the first consistent snapshot, then take a second one to
  // cover output produced between that snapshot and subscription. streamOffset
  // makes events racing either read idempotent.
  deps.attach();
  await mapConcurrent(entries, RESTORE_CONCURRENCY, async ({ tab }) => {
    const output = await deps.getOutput(tab.id).catch(() => null);
    if (output) deps.sessions.syncRestoredOutput(tab.id, output.output, output.endOffset);
  });
  return entries.length;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}
