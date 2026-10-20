/** Modes carried by the replay prefix at the first retained output byte. */
export interface ReplayModeState {
  alternate: boolean;
  mouse: "none" | "x10" | "vt200" | "drag" | "any";
  sgrMouse: boolean;
  focus: boolean;
  bracketedPaste: boolean;
  applicationCursor: boolean;
}

type ControlString = "osc" | "dcs" | "sos" | "pm" | "apc";
type ReplayScanner =
  | { state: "ground" }
  | { state: "escape" }
  | { state: "csi"; sequence: string }
  | { state: "string"; kind: ControlString; escapePending: boolean };

export interface ReplayModeTracker { state: ReplayModeState; scanner: ReplayScanner }
export const initialReplayModeTracker = (): ReplayModeTracker => ({
  state: { alternate: false, mouse: "none", sgrMouse: false, focus: false, bracketedPaste: false, applicationCursor: false },
  scanner: { state: "ground" },
});

const MAX_PENDING_CSI = 4096;
const ESC = "\x1b";
const CSI = "\x9b";
const ST = "\x9c";
const BEL = "\x07";
const mouseMode: Record<number, ReplayModeState["mouse"]> = { 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" };
const stringIntroducer: Record<ControlString, string> = { osc: "]", dcs: "P", sos: "X", pm: "^", apc: "_" };
type ModeChange = { field: keyof ReplayModeState; enabled: boolean; mouse?: ReplayModeState["mouse"] };

function controlStringForC1(ch: string): ControlString | null {
  if (ch === "\x9d") return "osc";
  if (ch === "\x90") return "dcs";
  if (ch === "\x98") return "sos";
  if (ch === "\x9e") return "pm";
  if (ch === "\x9f") return "apc";
  return null;
}

function beginString(tracker: ReplayModeTracker, kind: ControlString): void {
  tracker.scanner = { state: "string", kind, escapePending: false };
}

function scanCsi(tracker: ReplayModeTracker, sequence: string, ch: string, onChange?: (change: ModeChange) => void): void {
  if (ch === ESC) { tracker.scanner = { state: "escape" }; return; }
  if (ch === CSI) { tracker.scanner = { state: "csi", sequence: CSI }; return; }
  const stringKind = controlStringForC1(ch);
  if (stringKind) { beginString(tracker, stringKind); return; }
  if (ch === ST || ch === BEL) { tracker.scanner = { state: "ground" }; return; }

  sequence += ch;
  if (sequence.length > MAX_PENDING_CSI) { tracker.scanner = { state: "ground" }; return; }
  if (!/[\x40-\x7e]/.test(ch)) { tracker.scanner = { state: "csi", sequence }; return; }

  tracker.scanner = { state: "ground" };
  const body = sequence.slice(sequence.startsWith(CSI) ? 1 : 2, -1);
  if ((ch !== "h" && ch !== "l") || !body.startsWith("?")) return;
  const enabled = ch === "h";
  for (const raw of body.slice(1).split(";")) {
    const mode = Number(raw);
    if (!Number.isInteger(mode)) continue;
    if (mode === 1) { tracker.state.applicationCursor = enabled; onChange?.({ field: "applicationCursor", enabled }); }
    else if (mode === 47 || mode === 1047 || mode === 1049) { tracker.state.alternate = enabled; onChange?.({ field: "alternate", enabled }); }
    else if (mouseMode[mode]) {
      tracker.state.mouse = enabled ? mouseMode[mode] : (tracker.state.mouse === mouseMode[mode] ? "none" : tracker.state.mouse);
      onChange?.({ field: "mouse", enabled, mouse: mouseMode[mode] });
    }
    else if (mode === 1004) { tracker.state.focus = enabled; onChange?.({ field: "focus", enabled }); }
    else if (mode === 1006) { tracker.state.sgrMouse = enabled; onChange?.({ field: "sgrMouse", enabled }); }
    else if (mode === 2004) { tracker.state.bracketedPaste = enabled; onChange?.({ field: "bracketedPaste", enabled }); }
  }
}

/** Track only input-affecting DEC modes needed to reconstruct a remounted xterm.
 * CSI may span data chunks. Control strings are tracked across chunks and
 * terminated by their protocol terminators; escape handling within them follows
 * xterm so the replay boundary stays consistent with the VT mirror. */
export function consumeReplayModes(tracker: ReplayModeTracker, text: string, onChange?: (change: ModeChange) => void): void {
  for (const ch of text) {
    const scanner = tracker.scanner;
    if (scanner.state === "string") {
      if (ch === ST || (scanner.kind === "osc" && ch === BEL)) { tracker.scanner = { state: "ground" }; continue; }
      // xterm recognizes the 8-bit CSI control even while reading a string.
      if (ch === CSI) { tracker.scanner = { state: "csi", sequence: CSI }; continue; }
      if (scanner.escapePending) {
        if (ch === "\\") { tracker.scanner = { state: "ground" }; continue; }
        // A non-ST ESC returns xterm to escape parsing; preserve the string
        // only while consuming ordinary payload bytes.
        if (ch === ESC) scanner.escapePending = true;
        else if (ch === "[") tracker.scanner = { state: "csi", sequence: ESC + "[" };
        else {
          const kind = ch === "]" ? "osc" : ch === "P" ? "dcs" : ch === "X" ? "sos" : ch === "^" ? "pm" : ch === "_" ? "apc" : null;
          if (kind) beginString(tracker, kind);
          else tracker.scanner = { state: "ground" };
        }
      } else if (ch === ESC) scanner.escapePending = true;
      continue;
    }
    if (scanner.state === "csi") { scanCsi(tracker, scanner.sequence, ch, onChange); continue; }
    if (scanner.state === "escape") {
      if (ch === "[") tracker.scanner = { state: "csi", sequence: ESC + "[" };
      else {
        const kind = ch === "]" ? "osc" : ch === "P" ? "dcs" : ch === "X" ? "sos" : ch === "^" ? "pm" : ch === "_" ? "apc" : null;
        if (kind) beginString(tracker, kind);
        else if (ch === ESC) tracker.scanner = { state: "escape" };
        else if (ch === CSI) tracker.scanner = { state: "csi", sequence: CSI };
        else tracker.scanner = { state: "ground" };
      }
      continue;
    }
    if (ch === ESC) { tracker.scanner = { state: "escape" }; continue; }
    if (ch === CSI) { tracker.scanner = { state: "csi", sequence: CSI }; continue; }
    const kind = controlStringForC1(ch);
    if (kind) beginString(tracker, kind);
  }
}

/** Reconstruct the state immediately before a legacy retained tail. Older
 * hosts did not serialize this boundary. Explicit boolean DECSET/DECRSTs can
 * be undone from the current VT state; mouse disables are conditional, so
 * keep their current state as the conservative baseline. */
export function legacyReplayModeTracker(current: ReplayModeState, retained: string): ReplayModeTracker {
  const changes: ModeChange[] = [];
  const scanned = initialReplayModeTracker();
  consumeReplayModes(scanned, retained, change => changes.push(change));
  const state = structuredClone(current);
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    if (change.field === "mouse") continue;
    state[change.field] = !change.enabled;
  }
  return { state, scanner: { state: "ground" } };
}

function scannerPrefix(scanner: ReplayScanner): string {
  if (scanner.state === "ground") return "";
  if (scanner.state === "escape") return ESC;
  if (scanner.state === "csi") return scanner.sequence;
  return ESC + stringIntroducer[scanner.kind] + (scanner.escapePending ? ESC : "");
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
  return prefix + scannerPrefix(tracker.scanner);
}

function scannerFromLegacyPending(pending: string): ReplayScanner {
  if (pending === "") return { state: "ground" };
  if (pending === ESC) return { state: "escape" };
  return { state: "csi", sequence: pending };
}

export function validateReplayModeTracker(value: unknown): ReplayModeTracker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid replay mode state");
  const d = value as Record<string, unknown>, s = d.state as Record<string, unknown>;
  if (!s || typeof s !== "object" || Array.isArray(s) ||
      Object.keys(s).sort().join(",") !== "alternate,applicationCursor,bracketedPaste,focus,mouse,sgrMouse" ||
      typeof s.alternate !== "boolean" || typeof s.applicationCursor !== "boolean" || typeof s.bracketedPaste !== "boolean" ||
      typeof s.focus !== "boolean" || typeof s.sgrMouse !== "boolean" || !["none", "x10", "vt200", "drag", "any"].includes(String(s.mouse)))
    throw new Error("Invalid replay mode state");

  // Accept checkpoints from the just-prior development shape, which represented
  // only the ESC/CSI suffix. It had no control-string state to preserve.
  if (Object.keys(d).sort().join(",") === "pending,state") {
    const pending = d.pending;
    if (typeof pending !== "string" || pending.length > MAX_PENDING_CSI ||
        !(pending === "" || pending === ESC || pending === CSI || pending.startsWith(ESC + "[") || pending.startsWith(CSI)))
      throw new Error("Invalid replay mode state");
    return { state: structuredClone(s) as unknown as ReplayModeState, scanner: scannerFromLegacyPending(pending) };
  }

  if (Object.keys(d).sort().join(",") !== "scanner,state" || !d.scanner || typeof d.scanner !== "object" || Array.isArray(d.scanner))
    throw new Error("Invalid replay mode state");
  const scanner = d.scanner as Record<string, unknown>;
  const scannerKeys = Object.keys(scanner).sort().join(",");
  let checked: ReplayScanner;
  if (scanner.state === "ground" && scannerKeys === "state") checked = { state: "ground" };
  else if (scanner.state === "escape" && scannerKeys === "state") checked = { state: "escape" };
  else if (scanner.state === "csi" && scannerKeys === "sequence" && typeof scanner.sequence === "string" &&
      scanner.sequence.length <= MAX_PENDING_CSI && (scanner.sequence.startsWith(ESC + "[") || scanner.sequence.startsWith(CSI)))
    checked = { state: "csi", sequence: scanner.sequence };
  else if (scanner.state === "string" && scannerKeys === "escapePending,kind" &&
      ["osc", "dcs", "sos", "pm", "apc"].includes(String(scanner.kind)) && typeof scanner.escapePending === "boolean")
    checked = { state: "string", kind: scanner.kind as ControlString, escapePending: scanner.escapePending };
  else throw new Error("Invalid replay mode state");
  return { state: structuredClone(s) as unknown as ReplayModeState, scanner: checked };
}
