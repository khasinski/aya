// A pane id sent from a command running in ANOTHER open project is borrowed:
// Codex's shared app-server daemon ran every pane's commands with the env of the
// pane that started it (codex-cli 0.158.0), so `aya` acted as that pane.

import type { ControlCaller } from "./control-protocol";
import { callerProject, real, within } from "./team-author";
import type { ProjectConfig } from "./types";

/** The refusal when the caller's pane id belongs to a project other than the
 *  one its cwd is in (worktrees and tab bindings count as the pane's own), else null. */
export async function foreignIdentity(
  projects: ProjectConfig[],
  { terminalId, cwd }: ControlCaller,
  worktrees: (directory: string) => Promise<string[]>,
): Promise<string | null> {
  if (!terminalId || !cwd) return null;
  const own = projects.find((p) => p.tabs.some((t) => t.id === terminalId));
  if (!own || own.remote) return null;
  const here = await real(cwd);
  const inside = async (dirs: string[]) => (await Promise.all(dirs.map(real))).some((dir) => within(here, dir));
  const bound = own.tabs.flatMap((t) => (t.cwd ? [t.cwd] : []));
  if (await inside([own.directory, ...bound])) return null;
  const other = await callerProject(projects, undefined, { cwd: here });
  if (!other || other === own || (await inside(await worktrees(own.directory)))) return null;
  return (
    `this command runs with another pane's identity (AYA_TERMINAL_ID=${terminalId}, a pane of project "${own.name}") in ${here}, project "${other.name}"; ` +
    "a CLI that runs commands in a shared background process - such as Codex's app-server daemon - loses the pane's identity. " +
    "Restart this pane (Aya now starts Codex with --no-daemon)"
  );
}
