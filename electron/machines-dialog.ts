// The user's yes for aya machines add: a native dialog in Aya, never an answer the CLI caller can give.

import type { BrowserWindow } from "electron";
import type { AddAsk } from "./machines";
import type { MachineStatus } from "./machines-probe";

const ADD_BUTTON = 0;
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
  return {
    message: count === 1 ? `Add ${ask.machines[0].id} to Aya's machines?` : `Add ${count} machines to Aya's machines?`,
    detail: `${who}Aya will only read their state over ssh; it never loads or unloads a model.\n\n${lines.join("\n\n")}`,
  };
}

export async function confirmAddInAya(ask: AddAsk, win: BrowserWindow | null): Promise<boolean> {
  // Lazy: plain Node tests load control.ts and must not load Electron.
  const { dialog } = require("electron") as typeof import("electron");
  const options = { type: "question" as const, buttons: ["Add", "Cancel"], defaultId: CANCEL_BUTTON, cancelId: CANCEL_BUTTON, noLink: true, ...addDialogText(ask) };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === ADD_BUTTON;
}
