/** Modes carried by the replay prefix at the first retained output byte. */
export interface ReplayModeState {
  alternate: boolean;
  mouse: "none" | "x10" | "vt200" | "drag" | "any";
  sgrMouse: boolean;
  focus: boolean;
  bracketedPaste: boolean;
  applicationCursor: boolean;
}
export interface ReplayModeTracker { state: ReplayModeState; pending: string }
export const initialReplayModeTracker = (): ReplayModeTracker => ({
  state: { alternate: false, mouse: "none", sgrMouse: false, focus: false, bracketedPaste: false, applicationCursor: false },
  pending: "",
});
const MAX_PENDING_CSI = 4096;
const mouseMode: Record<number, ReplayModeState["mouse"]> = { 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" };

/** Track only input-affecting DEC modes needed to reconstruct a remounted xterm.
 * CSI may span data chunks; pending preserves an incomplete sequence if its
 * prefix is evicted while its final bytes remain in the retained tail. */
export function consumeReplayModes(tracker: ReplayModeTracker, text: string): void {
  for (const ch of text) {
    if (!tracker.pending) {
      if (ch === "\x1b" || ch === "\x9b") tracker.pending = ch;
      continue;
    }
    if (tracker.pending === "\x1b") {
      if (ch === "[") tracker.pending += ch;
      else tracker.pending = ch === "\x1b" || ch === "\x9b" ? ch : "";
      continue;
    }
    if (tracker.pending === "\x9b" || tracker.pending.startsWith("\x1b[")) {
      if (ch === "\x1b" || ch === "\x9b") { tracker.pending = ch; continue; }
      tracker.pending += ch;
      if (tracker.pending.length > MAX_PENDING_CSI) { tracker.pending = ""; continue; }
      if (!/[\x40-\x7e]/.test(ch)) continue;
      const body = tracker.pending.slice(tracker.pending[0] === "\x9b" ? 1 : 2, -1);
      const final = ch;
      tracker.pending = "";
      if ((final !== "h" && final !== "l") || !body.startsWith("?")) continue;
      const enabled = final === "h";
      for (const raw of body.slice(1).split(";")) {
        const mode = Number(raw);
        if (!Number.isInteger(mode)) continue;
        if (mode === 1) tracker.state.applicationCursor = enabled;
        else if (mode === 47 || mode === 1047 || mode === 1049) tracker.state.alternate = enabled;
        else if (mouseMode[mode]) tracker.state.mouse = enabled ? mouseMode[mode] : (tracker.state.mouse === mouseMode[mode] ? "none" : tracker.state.mouse);
        else if (mode === 1004) tracker.state.focus = enabled;
        else if (mode === 1006) tracker.state.sgrMouse = enabled;
        else if (mode === 2004) tracker.state.bracketedPaste = enabled;
      }
    } else {
      tracker.pending = ch === "\x1b" || ch === "\x9b" ? ch : "";
    }
  }
}
export function replayModePrefix(tracker: ReplayModeTracker): string {
  const { state } = tracker;
  let prefix = "";
  if (state.alternate) prefix += "\x1b[?1049h";
  if (state.mouse !== "none") prefix += `\x1b[?${({ x10: 9, vt200: 1000, drag: 1002, any: 1003 })[state.mouse]}h`;
  if (state.sgrMouse) prefix += "\x1b[?1006h";
  if (state.focus) prefix += "\x1b[?1004h";
  if (state.bracketedPaste) prefix += "\x1b[?2004h";
  if (state.applicationCursor) prefix += "\x1b[?1h";
  return prefix + tracker.pending;
}
export function validateReplayModeTracker(value: unknown): ReplayModeTracker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid replay mode state");
  const d = value as Record<string, unknown>, s = d.state as Record<string, unknown>;
  if (Object.keys(d).sort().join(",") !== "pending,state" || !s || typeof s !== "object" || Array.isArray(s) ||
      Object.keys(s).sort().join(",") !== "alternate,applicationCursor,bracketedPaste,focus,mouse,sgrMouse" ||
      typeof s.alternate !== "boolean" || typeof s.applicationCursor !== "boolean" || typeof s.bracketedPaste !== "boolean" ||
      typeof s.focus !== "boolean" || typeof s.sgrMouse !== "boolean" || !["none", "x10", "vt200", "drag", "any"].includes(String(s.mouse)) ||
      typeof d.pending !== "string" || d.pending.length > MAX_PENDING_CSI || !(d.pending === "" || d.pending === "\x1b" || d.pending === "\x9b" || d.pending.startsWith("\x1b[") || d.pending.startsWith("\x9b")))
    throw new Error("Invalid replay mode state");
  return structuredClone(value) as ReplayModeTracker;
}
