// Which team's debug log a pane's decision or a socket answer goes to. It needs the team files and the
// store, so it sits above them; team-debug.ts stays a leaf that the store and the runner can import.

import type { ControlCaller, ControlRequest } from "./control-protocol";
import { callerProject } from "./team-author";
import { debugLog, debugOn } from "./team-debug";
import { paneTeamRole } from "./team-files";
import { openTeamStore } from "./team-store";
import type { ProjectConfig } from "./types";

type DebugDeps = { teamHome: string; listProjects: () => Promise<ProjectConfig[]> };

/** A decision about a pane, in the debug log of the team it plays a role in, if any. */
export async function debugPane(deps: DebugDeps, paneId: string, event: string, fields: Record<string, unknown>): Promise<void> {
  if (!debugOn()) return;
  try {
    const project = (await deps.listProjects()).find((p) => p.tabs.some((t) => t.id === paneId));
    const plays = project ? await paneTeamRole(deps.teamHome, project, paneId) : null;
    if (plays) debugLog(plays.store, event, { pane: paneId, role: plays.role, ...fields });
  } catch {
    // A removed team or a full disk: debugging must never stop the team.
  }
}

/** The socket's answer to an aya team command, in a team's debug log (the team it names, else its pane's team). */
export async function debugAnswer<T>(
  deps: DebugDeps | undefined,
  request: ControlRequest,
  caller: ControlCaller,
  answer: Promise<T>,
): Promise<T> {
  if (!debugOn() || !deps || !request.type.startsWith("team-")) return answer;
  const fields = { command: request.type, caller: caller.terminalId ?? null, ...(request.type === "team-send" ? { to: request.role, text: request.text } : {}) };
  const log = async (outcome: Record<string, unknown>) => {
    try {
      const named = "team" in request ? request.team : undefined;
      const project = "cwd" in request ? await callerProject(await deps.listProjects(), caller.terminalId, request) : null;
      if (named && project) return debugLog(openTeamStore(deps.teamHome, project.slug, named), "socket", { ...fields, ...outcome });
      if (caller.terminalId) await debugPane(deps, caller.terminalId, "socket", { ...fields, ...outcome });
    } catch {
      // as above
    }
  };
  try {
    const value = await answer;
    const output = (value as { output?: unknown } | undefined)?.output;
    await log({ ok: true, ...(typeof output === "string" ? { output } : {}) });
    return value;
  } catch (err) {
    await log({ ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
