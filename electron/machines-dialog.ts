// The user's yes for aya machines add: a native dialog in Aya, never an answer the CLI caller can give.

import type { BrowserWindow } from "electron";
import type { AddAsk, MachinesDeps } from "./machines";
import type { ProjectConfig } from "./types";
import type { MachineStatus } from "./machines-probe";
import type { HostOrigin } from "./ssh-host-store";
import { paneTeamRole } from "./team-files";

const ACTION_BUTTON = 0;
const CANCEL_BUTTON = 1;

function found(s: MachineStatus): string {
  if (!s.reachable) return `unreachable: ${s.error}`;
  const gpu = s.gpus.length ? s.gpus.map((g) => g.name).join(", ") : "no NVIDIA GPU";
  const ollama = !s.ollama.up
    ? "Ollama not answering"
    : `Ollama ${s.ollama.version ?? "?"}, ${s.ollama.loaded === null ? "models unknown" : `${s.ollama.loaded.length} model(s) loaded`}`;
  return `connected, ${s.cpus ?? "?"} CPUs, ${gpu}, ${ollama}`;
}

/** The dialog's text, apart from Electron so it can be read in a test. */
export function addDialogText(ask: AddAsk): { message: string; detail: string } {
  const count = ask.machines.length;
  const lines = ask.machines.map((m) => `${m.id}  (${m.reach === "local" ? "this machine" : `ssh ${m.reach.ssh}`}, Ollama port ${m.port})\n  ${found(m.status)}`);
  const who = ask.pane ? `Asked by pane "${ask.pane}". ` : "";
  const overSsh = ask.machines.some((m) => m.reach !== "local") ? " over ssh" : "";
  return {
    message: count === 1 ? `Add ${ask.machines[0].id} to Aya's machines?` : `Add ${count} machines to Aya's machines?`,
    detail: `${who}Aya will only read ${count === 1 ? "its" : "their"} state${overSsh}; it never loads or unloads a model.\n\n${lines.join("\n\n")}`,
  };
}

export async function confirmAddInAya(ask: AddAsk, win: BrowserWindow | null, signal?: AbortSignal): Promise<boolean> {
  // Lazy: plain Node tests load control.ts and must not load Electron.
  const { dialog } = require("electron") as typeof import("electron");
  const options = { type: "question" as const, buttons: ["Add", "Cancel"], defaultId: CANCEL_BUTTON, cancelId: CANCEL_BUTTON, noLink: true, signal, ...addDialogText(ask) };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === ACTION_BUTTON;
}

/** The user's yes before a machine leaves Aya's list: the same native dialog as Add, its button naming the action. */
export async function confirmRemoveInAya(id: string, win: BrowserWindow | null, signal?: AbortSignal): Promise<boolean> {
  const { dialog } = require("electron") as typeof import("electron");
  const options = {
    type: "question" as const,
    buttons: ["Remove", "Cancel"],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
    signal,
    message: `Remove ${id} from Aya's machines?`,
    detail: "Aya stops reading its state; nothing changes on the machine.",
  };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === ACTION_BUTTON;
}

/** A remote project's panes, each with the team role it plays, if any (team roles live under the Aya config home). */
async function remotePanes(ayaHome: string, project: ProjectConfig): Promise<{ name: string; role?: string; team?: string }[]> {
  return Promise.all(
    project.tabs.map(async (tab) => {
      const played = await paneTeamRole(ayaHome, project, tab.id).catch(() => null);
      return played ? { name: tab.name, role: played.role, team: played.team } : { name: tab.name };
    }),
  );
}

/** The deps every caller in Aya uses (the control socket and the Settings IPC), so the CLI and the UI share one path. */
export function ayaMachinesDeps(
  ayaHome: string,
  userHome: string,
  getWindow: () => BrowserWindow | null,
  listProjects?: () => Promise<ProjectConfig[]>,
  origin?: HostOrigin,
): MachinesDeps {
  return {
    ayaHome,
    userHome,
    origin,
    listRemoteProjects: async () =>
      Promise.all(
        ((await listProjects?.()) ?? []).flatMap((p) =>
          p.remote ? [remotePanes(ayaHome, p).then((panes) => ({ name: p.name, sshTarget: p.remote!.sshTarget, panes }))] : [],
        ),
      ),
    confirmAdd: (ask, signal) => confirmAddInAya(ask, getWindow(), signal),
    confirmRemove: (id, signal) => confirmRemoveInAya(id, getWindow(), signal),
  };
}
