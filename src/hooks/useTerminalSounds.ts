import { useEffect, useRef } from "react";
import doneSoundUrl from "../assets/sounds/done.wav";
import waitingSoundUrl from "../assets/sounds/waiting.wav";
import { isTerminalDone } from "../pty-event-reducer";
import {
  isWatchingTerminal,
  shouldPlayTerminalSound,
  terminalSoundUrl,
  type TerminalSoundCue,
  type TerminalSoundPrefs,
} from "../terminal-sound-prefs";
import type { TerminalState } from "../types";

const BUNDLED_SOUNDS: Record<TerminalSoundCue, string> = {
  waiting: waitingSoundUrl,
  done: doneSoundUrl,
};

function playSound(url: string): void {
  const audio = new Audio(url);
  void audio.play().catch(() => {
    // Autoplay can be blocked in odd embedded contexts (Aya Web without a
    // prior user gesture), and a user-chosen file can go missing after it was
    // picked; a silent chime isn't worth interrupting the user over.
  });
}

interface Options {
  terminals: Record<string, TerminalState>;
  /** The single currently-selected tab, if any — gates the completion sound
   *  so a terminal the user is already looking at doesn't also ding. */
  activeTerminalId: string | null;
  /** Optional set of terminal IDs currently visible in a split layout. */
  visibleTerminalIds?: ReadonlySet<string> | readonly string[];
  prefs: TerminalSoundPrefs;
}

interface TrackedState {
  bell: boolean;
  done: boolean;
}

function isPaneVisibleOnScreen(
  id: string,
  visibleTerminalIds?: ReadonlySet<string> | readonly string[],
): boolean {
  if (visibleTerminalIds) {
    if (Array.isArray(visibleTerminalIds)) {
      if (visibleTerminalIds.includes(id)) return true;
    } else if ((visibleTerminalIds as ReadonlySet<string>).has(id)) {
      return true;
    }
  }
  if (typeof document === "undefined") return false;
  const panes = document.querySelectorAll<HTMLElement>('[data-testid="terminal-pane"]');
  for (let i = 0; i < panes.length; i += 1) {
    const pane = panes[i];
    if (pane.dataset.terminalId === id && pane.style.display !== "none") {
      return true;
    }
  }
  return false;
}

/** Two short chimes for the two moments a user looks away and needs to know
 *  something happened: "waiting" (rings on every transition into it, mirrors
 *  useTerminalNotifications' desktop notification) and "done" (only for the
 *  terminal(s) not currently in view — the user watching one pane finish
 *  doesn't need an audible cue for it). */
export function useTerminalSounds({
  terminals,
  activeTerminalId,
  visibleTerminalIds,
  prefs,
}: Options): void {
  const prevRef = useRef<Record<string, TrackedState>>({});
  const hydratedRef = useRef(false);

  useEffect(() => {
    const prev = prevRef.current;
    const entries = Object.entries(terminals);
    const isInitialBatch = !hydratedRef.current && entries.length > 0;
    if (entries.length > 0) hydratedRef.current = true;
    const windowFocused = typeof document !== "undefined" && document.hasFocus();
    const next: Record<string, TrackedState> = {};
    for (const [id, t] of entries) {
      const done = isTerminalDone(t);
      next[id] = { bell: t.bell, done };
      if (isInitialBatch) continue;
      const prior = prev[id];
      const becameBell = t.bell && !prior?.bell;
      const becameDone = done && prior !== undefined && !prior.done;
      if (!becameBell && !becameDone) continue;
      if (!shouldPlayTerminalSound(prefs, t.presetId)) continue;
      const watching =
        isWatchingTerminal(id, activeTerminalId, windowFocused) ||
        (windowFocused && isPaneVisibleOnScreen(id, visibleTerminalIds));
      if (watching) continue;
      if (becameBell) {
        playSound(terminalSoundUrl(prefs, "waiting", BUNDLED_SOUNDS));
      } else if (becameDone) {
        playSound(terminalSoundUrl(prefs, "done", BUNDLED_SOUNDS));
      }
    }
    prevRef.current = next;
  }, [terminals, activeTerminalId, visibleTerminalIds, prefs]);
}
