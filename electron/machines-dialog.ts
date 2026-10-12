// The user's yes for aya machines add, remove and configure: a native dialog in Aya, never an answer the CLI caller can give.

import type { BrowserWindow } from "electron";
import { printable } from "./printable";
import type { AddAsk, ConfigureAsk, MachinesDeps } from "./machines";
import type { ProjectConfig } from "./types";
import type { MachineStatus } from "./machines-probe";

const ACTION_BUTTON = 0;
const CANCEL_BUTTON = 1;

function found(s: MachineStatus): string {
  if (!s.reachable) return `unreachable: ${s.error}`;
  const gpu = s.gpus.length ? s.gpus.map((g) => g.name).join(", ") : (s.cpuName ?? "no NVIDIA GPU");
  const ollama = !s.ollama.up
    ? s.ollama.installed === false
      ? "Ollama not installed"
      : s.ollama.running === false
        ? "Ollama not running"
        : "Ollama not answering"
    : `Ollama ${s.ollama.version ?? "?"}, ${s.ollama.loaded === null ? "models unknown" : `${s.ollama.loaded.length} model(s) loaded`}`;
  return `connected, ${s.cpus ?? "?"} CPUs, ${gpu}, ${ollama}`;
}

/** The dialog's text, apart from Electron so it can be read in a test. */
export function addDialogText(ask: AddAsk): { message: string; detail: string } {
  const count = ask.machines.length;
  const lines = ask.machines.map((m) => `${m.id}  (${m.reach === "local" ? "this machine" : `ssh ${m.reach.ssh}`}, Ollama port ${m.port})\n  ${found(m.status)}`);
  const who = ask.pane ? `Asked by pane "${ask.pane}". ` : "";
  const overSsh = ask.machines.some((m) => m.reach !== "local") ? " over ssh" : "";
  // What the probe found (ssh errors, model names) and the pane's name come from outside Aya: shown as text (printable.ts).
  return {
    message: printable(count === 1 ? `Add ${ask.machines[0].id} to Aya's machines?` : `Add ${count} machines to Aya's machines?`),
    detail: printable(`${who}Aya will only read ${count === 1 ? "its" : "their"} state${overSsh}; it never loads or unloads a model.\n\n${lines.join("\n\n")}`),
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

const TOKEN_EFFECT: Record<ConfigureAsk["token"], string> = {
  stored: "The token piped to the command is saved for this URL, replacing any saved token.",
  kept: "The saved API token is kept.",
  removed: "The saved API token is deleted; it cannot be recovered.",
  none: "",
};

/** The dialog's text, apart from Electron so it can be read in a test. */
export function configureDialogText(ask: ConfigureAsk): { message: string; detail: string } {
  const to = ask.backend === "ollama" ? `Ollama on port ${ask.target}` : "an OpenAI-compatible API";
  const who = ask.pane ? `Asked by pane "${ask.pane}". ` : "";
  const url = ask.backend === "ollama" ? "" : `API URL: ${ask.target}\n\n`;
  const effect = TOKEN_EFFECT[ask.token];
  // The pane's name and the URL come from the caller: shown as text (printable.ts).
  return {
    message: printable(`Change ${ask.id} to ${to}?`),
    detail: printable(`${who}${url}${effect ? `${effect}\n\n` : ""}Aya only reads its state and model list; nothing changes on the machine.`),
  };
}

/** The user's yes before a pane changes a machine's backend or its token: the same native dialog as Remove. */
export async function confirmConfigureInAya(ask: ConfigureAsk, win: BrowserWindow | null, signal?: AbortSignal): Promise<boolean> {
  const { dialog } = require("electron") as typeof import("electron");
  const options = { type: "question" as const, buttons: ["Change", "Cancel"], defaultId: CANCEL_BUTTON, cancelId: CANCEL_BUTTON, noLink: true, signal, ...configureDialogText(ask) };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === ACTION_BUTTON;
}

/** The deps every caller in Aya uses (the control socket and Settings), so the CLI and the UI share one path. */
export function ayaMachinesDeps(ayaHome: string, userHome: string, getWindow: () => BrowserWindow | null, listProjects?: () => Promise<ProjectConfig[]>): MachinesDeps {
  return {
    ayaHome,
    userHome,
    listRemoteProjects: async () => ((await listProjects?.()) ?? []).flatMap((p) => (p.remote ? [{ name: p.name, sshTarget: p.remote.sshTarget }] : [])),
    confirmAdd: (ask, signal) => confirmAddInAya(ask, getWindow(), signal),
    confirmRemove: (id, signal) => confirmRemoveInAya(id, getWindow(), signal),
    confirmConfigure: (ask, signal) => confirmConfigureInAya(ask, getWindow(), signal),
  };
}
