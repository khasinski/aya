// How much of a turn the Conversation GUI shows: tool calls (all, failed only, none) and Zen mode (your messages
// and the agent's final reply per turn). One preference for every pane, remembered across restarts.

export type ToolCallVisibility = "all" | "failed" | "none";
export interface GuiViewPrefs { tools: ToolCallVisibility; zen: boolean }

/** localStorage key of the view preference. */
export const GUI_VIEW_STORAGE_KEY = "aya:gui-view";
export const DEFAULT_GUI_VIEW: GuiViewPrefs = { tools: "all", zen: false };
export const TOOL_VISIBILITY_LABELS: Record<ToolCallVisibility, string> = { all: "Show all", failed: "Hide successful", none: "Hide all" };

export function parseGuiViewPrefs(raw: string | null): GuiViewPrefs {
  try {
    const value = JSON.parse(raw || "{}") as Record<string, unknown>;
    const tools = value.tools === "failed" || value.tools === "none" ? value.tools : "all";
    return { tools, zen: value.zen === true };
  } catch { return DEFAULT_GUI_VIEW; }
}

/** Zen mode: Cmd/Ctrl+Alt+Z (Option changes the key on a Mac, so the physical key is checked). */
export function isZenShortcut(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === "KeyZ";
}

const listeners = new Set<() => void>();
let current: GuiViewPrefs | null = null;

export function getGuiViewPrefs(): GuiViewPrefs {
  if (!current) {
    try { current = parseGuiViewPrefs(localStorage.getItem(GUI_VIEW_STORAGE_KEY)); } catch { current = DEFAULT_GUI_VIEW; }
  }
  return current;
}

export function setGuiViewPrefs(change: Partial<GuiViewPrefs>): void {
  current = { ...getGuiViewPrefs(), ...change };
  try { localStorage.setItem(GUI_VIEW_STORAGE_KEY, JSON.stringify(current)); } catch { /* lasts until reload */ }
  for (const listener of listeners) listener();
}

export function subscribeGuiViewPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The tool calls to show: "failed" keeps a call while it runs and afterwards only if it failed. */
export function visibleActivities<T extends { status: string }>(activities: readonly T[], tools: ToolCallVisibility): T[] {
  if (tools === "none") return [];
  if (tools === "failed") return activities.filter(a => a.status === "inProgress" || a.status === "failed" || a.status === "declined");
  return [...activities];
}

/** Zen: your messages and, per turn, the agent's last reply once the turn has ended. A reply that asks a question
 *  always stays, because it waits for an answer. Progress, goal and settings entries are hidden. */
export function zenMessages<T extends { type: string }>(messages: readonly T[], busy: boolean, asksQuestion: (m: T) => boolean = () => false): T[] {
  const shown: T[] = [];
  let lastReply: T | null = null;
  const closeTurn = () => { if (lastReply) shown.push(lastReply); lastReply = null; };
  for (const m of messages) {
    if (m.type === "user") { closeTurn(); shown.push(m); continue; }
    if (m.type !== "assistant") continue;
    if (asksQuestion(m)) { lastReply = null; shown.push(m); continue; }
    lastReply = m;
  }
  if (!busy) closeTurn();
  return shown;
}

/** `compute` once per object: messages are replaced, never changed in place, when a streamed delta extends one, so the
 *  questions of every other message are parsed once instead of on each frame (Zen's filter, keepMounted, rendering). */
export function memoizeByObject<T extends object, R>(compute: (value: T) => R): (value: T) => R {
  const known = new WeakMap<T, R>();
  return value => {
    if (known.has(value)) return known.get(value) as R;
    const result = compute(value);
    known.set(value, result);
    return result;
  };
}
