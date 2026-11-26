// What main.ts's native windows show, apart from Electron so a plain Node test can read it. Tab and project names
// come from config files an agent can write too, so they are shown as text (printable.ts).

import { printable } from "./printable";

/** The waiting-for-input notification; `body` names the tab and its project.
 *  Always `silent: true` because renderer `useTerminalSounds` owns the waiting chime
 *  (and respects the Terminal sounds toggle and per-preset overrides). */
export function waitingNotification(body: string): { title: string; body: string; silent: boolean } {
  return { title: "Aya - waiting for input", body: printable(body), silent: true };
}

/** A native message box grows with its text and does not scroll: a long list of panes pushed its buttons off the
 *  screen (2026-11-18, the stale-host restart question with every retained process on its own line). */
export const DIALOG_LIST_LIMIT = 8;
const DIALOG_LINE_WIDTH = 90;
const DIALOG_DETAIL_LINES = 22;
const DIALOG_DETAIL_CHARS = 1600;

const cutLine = (line: string): string => (line.length > DIALOG_LINE_WIDTH ? `${line.slice(0, DIALOG_LINE_WIDTH - 1)}…` : line);

/** `items` one per line for a dialog: the first DIALOG_LIST_LIMIT, each cut to one short line, then how many were
 *  left out. `always` lines (a summary such as "3 more unknown") follow and are never dropped. */
export function dialogList(items: readonly string[], always: readonly string[] = []): string {
  const shown = items.slice(0, DIALOG_LIST_LIMIT).map((item) => cutLine(item.replace(/\s+/g, " ").trim()));
  const hidden = items.length - shown.length;
  if (hidden > 0) shown.push(`and ${hidden} more`);
  return [...shown, ...always.map(cutLine)].join("\n");
}

/** The last guard for any dialog detail, whatever built it: a bounded number of lines and characters. */
export function dialogDetail(text: string): string {
  const lines = printable(text).split("\n");
  const kept = lines.length > DIALOG_DETAIL_LINES ? [...lines.slice(0, DIALOG_DETAIL_LINES - 1), "…"] : lines;
  const joined = kept.join("\n");
  return joined.length > DIALOG_DETAIL_CHARS ? `${joined.slice(0, DIALOG_DETAIL_CHARS - 1)}…` : joined;
}

/** The yes/no before a restart that stops work in panes; `yes` names the restart, `text` lists what stops. */
export function restartDialog(yes: string, text: string) {
  return {
    type: "warning" as const,
    buttons: [printable(yes), "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Work in progress will stop",
    detail: dialogDetail(text),
  };
}

/** A hidden test run (AYA_E2E_HEADLESS) must not ding at whoever is at the machine: its notifications are silent. */
export function quietWhenTesting<T extends { silent?: boolean }>(options: T, headless: boolean): T {
  return headless ? { ...options, silent: true } : options;
}
