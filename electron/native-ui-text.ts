// What main.ts's native windows show, apart from Electron so a plain Node test can read it. Tab and project names
// come from config files an agent can write too, so they are shown as text (printable.ts).

import { printable } from "./printable";

/** The waiting-for-input notification; `body` names the tab and its project. */
export function waitingNotification(body: string): { title: string; body: string; silent: boolean } {
  return { title: "Aya - waiting for input", body: printable(body), silent: false };
}

/** The yes/no before a restart that stops background work; `yes` names the restart, `text` lists what stops. */
export function restartDialog(yes: string, text: string) {
  return {
    type: "warning" as const,
    buttons: [printable(yes), "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Background tasks will stop",
    detail: printable(text),
  };
}
