// Panes whose process called aya, which settles an unknown launch verdict. A call counts only
// when the process table shows it runs under the pane's process; the env's pane id is a claim.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { processTable as liveTable, unprovenIdentity, type ProcessTable } from "./caller-proof";
import type { ControlCaller } from "./control-protocol";

export interface ReachDeps {
  /** The pane's process: null when it has none, undefined when the host cannot say. */
  panePid: (terminalId: string) => Promise<number | null | undefined>;
  processTable?: (pid: number) => Promise<ProcessTable | null>;
  /** Where the proofs outlive a quit of Aya: the pty host, and so the pane's process, does. */
  file?: string;
  /** Told the first time a pane's process is proven to have called aya. */
  onReached?: (terminalId: string) => void;
}

async function load(file: string | undefined): Promise<Map<string, number>> {
  if (!file) return new Map();
  try {
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    return new Map(Object.entries(saved).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return new Map();
  }
}

export function reachedAyaPanes(deps: ReachDeps) {
  const loaded = load(deps.file);
  const has = async (terminalId: string): Promise<boolean> => {
    const proven = (await loaded).get(terminalId);
    return proven !== undefined && proven === (await deps.panePid(terminalId));
  };
  return {
    has,
    /** A call that proves nothing (no pid, no process table, no pane process) settles nothing. */
    async called({ terminalId, pid }: ControlCaller): Promise<void> {
      if (!terminalId || !pid || (await has(terminalId))) return;
      const panePid = await deps.panePid(terminalId);
      const table = await (deps.processTable ?? liveTable)(pid);
      if (panePid == null || !table?.has(pid) || unprovenIdentity({ terminalId, pid }, panePid, table) !== null) return;
      const reached = await loaded;
      reached.set(terminalId, panePid);
      deps.onReached?.(terminalId);
      if (deps.file) await writeFileAtomic(deps.file, JSON.stringify(Object.fromEntries(reached))).catch(() => {});
    },
  };
}
