// Pure state machine for the Shift-Shift global search shortcut. Extracted
// from useDoubleShiftSearch so the timing window, modifier-exclusion, and
// chain-break rules can be tested without simulating real DOM events.
//
// Two Shift key-ups within DOUBLE_SHIFT_WINDOW_MS fire the trigger, unless
// another key was pressed between them (which resets the chain), or a
// modifier was held during the second tap (Cmd-Shift, Ctrl-Shift, etc).

export interface DoubleShiftState {
  /** Timestamp of the most recent Shift key-up. */
  lastShiftUp: number;
  /** True if a single Shift tap has been seen and is waiting for a second. */
  chainActive: boolean;
}

export interface KeyboardEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export interface KeyUpResult {
  state: DoubleShiftState;
  /** True if this key-up completed a double-shift chord. */
  triggered: boolean;
}

export const DOUBLE_SHIFT_WINDOW_MS = 300;

export const initialDoubleShiftState: DoubleShiftState = {
  lastShiftUp: 0,
  chainActive: false,
};

/** Any non-Shift key press during the chain breaks it: "Shift-A-Shift" must
 *  not trigger search. */
export function handleKeyDown(
  state: DoubleShiftState,
  event: KeyboardEventLike,
): DoubleShiftState {
  if (event.key === "Shift") return state;
  if (!state.chainActive) return state;
  return { ...state, chainActive: false };
}

/** The decision happens on key-up so the user can tap-tap without the OS
 *  emitting key-repeat. */
export function handleKeyUp(
  state: DoubleShiftState,
  event: KeyboardEventLike,
  now: number,
): KeyUpResult {
  if (event.key !== "Shift") return { state, triggered: false };
  // Exclude Cmd-Shift / Ctrl-Shift / Alt-Shift — those are real chords (e.g.
  // ⇧⇧ vs ⌘⇧F) and shouldn't fire global search.
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return { state, triggered: false };
  }
  if (state.chainActive && now - state.lastShiftUp < DOUBLE_SHIFT_WINDOW_MS) {
    return {
      state: { lastShiftUp: now, chainActive: false },
      triggered: true,
    };
  }
  return {
    state: { lastShiftUp: now, chainActive: true },
    triggered: false,
  };
}
