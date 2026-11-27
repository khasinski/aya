// Screen-reader support for Conversation GUI panes: what a polite live region says when a turn starts, finishes or
// needs the user, and the window title that leads with the focused pane's status ("Working — Claude GUI — Aya").

import type { GuiPaneStatus } from "./gui-status";

/** What to announce when a pane's status changes from `previous` to `next`, or null when nothing worth saying
 *  changed. A status reported once on mount (`previous` null) is the pane's history, not news. */
export function guiAnnouncement(previous: GuiPaneStatus | null, next: GuiPaneStatus): string | null {
  if (previous === null || next === "clear") return null;
  if (previous !== "clear" && previous.level === next.level && previous.text === next.text) return null;
  // A running turn that changes its working text (a subagent count) is not news.
  if (next.level === "active" && previous !== "clear" && previous.level === "active") return null;
  return next.text;
}

/** Puts text in a live region so it is read even when it equals the last announcement: the region is emptied first
 *  and the text set on the next frame, which screen readers hear as a change. A newer announcement cancels the pending one. */
export function createAnnouncer(set: (text: string) => void, nextFrame: (run: () => void) => unknown = run => requestAnimationFrame(run)) {
  let revision = 0;
  return (text: string) => {
    const mine = ++revision;
    set("");
    nextFrame(() => { if (mine === revision) set(text); });
  };
}

/** The words a window title leads with for a status: null when the status does not need the user's eyes. */
export function titleStatus(status: GuiPaneStatus): string | null {
  if (status === "clear") return null;
  if (status.level === "active") return "Working";
  if (status.level === "waiting") return status.text.startsWith("Approval needed") ? "Needs approval" : "Needs your input";
  if (status.level === "error" && status.text.startsWith("Limited")) return "Limited";
  return null;
}

/** "Needs approval — Claude GUI — Aya", or null to show the window's own title. It ends with the app's name: the
 *  title stands for the whole window in Mission Control, the Window menu and window switchers. */
export function guiWindowTitle(status: GuiPaneStatus, paneName: string): string | null {
  const lead = titleStatus(status);
  return lead ? `${lead} — ${paneName} — Aya` : null;
}

/** One pane at a time owns the window title; releasing it puts back the title the window had before. */
export function createWindowTitle(doc: { title: string }) {
  let owner: string | null = null;
  let base = "";
  return {
    set(id: string, title: string | null) {
      if (title === null) {
        if (owner !== id) return;
        doc.title = base;
        owner = null;
        return;
      }
      if (owner === null) base = doc.title;
      owner = id;
      if (doc.title !== title) doc.title = title;
    },
    get owner() { return owner; },
  };
}
