// Which chime (if any) a terminal transition should play. Pure so the
// precedence rules — global toggle, per-preset override, custom file — are
// testable without React or an audio device.

export type TerminalSoundCue = "waiting" | "done";

export interface TerminalSoundPrefs {
  /** Master switch. Off means silence regardless of per-preset overrides. */
  enabled: boolean;
  /** presetId -> enabled. A missing entry inherits `enabled`, so the map only
   *  ever stores deliberate exceptions. */
  overrides: Record<string, boolean>;
  /** Absolute paths to user-chosen audio files; null uses the bundled chime. */
  customWaitingPath: string | null;
  customDonePath: string | null;
}

export const DEFAULT_TERMINAL_SOUND_PREFS: TerminalSoundPrefs = {
  enabled: true,
  overrides: {},
  customWaitingPath: null,
  customDonePath: null,
};

export function shouldPlayTerminalSound(
  prefs: TerminalSoundPrefs,
  presetId: string,
): boolean {
  if (!prefs.enabled) return false;
  return prefs.overrides[presetId] ?? true;
}

/** A visible terminal needs no chime only while the Aya window itself has
 * focus. If Aya is in the background, the selected tab is not being watched. */
export function isWatchingTerminal(
  terminalId: string,
  activeTerminalId: string | null,
  documentFocused: boolean,
): boolean {
  return documentFocused && terminalId === activeTerminalId;
}

/** Resolve a cue to a playable URL. Custom files are on-disk absolute paths,
 *  which need the file:// scheme to load from the renderer; the bundled
 *  fallbacks arrive as already-resolved bundler URLs. */
export function terminalSoundUrl(
  prefs: TerminalSoundPrefs,
  cue: TerminalSoundCue,
  bundled: Record<TerminalSoundCue, string>,
): string {
  const custom =
    cue === "waiting" ? prefs.customWaitingPath : prefs.customDonePath;
  if (!custom) return bundled[cue];
  return custom.startsWith("file://") ? custom : `file://${custom}`;
}

/** Drop overrides that match the global default so the stored map stays a set
 *  of real exceptions instead of growing an entry per preset the user toggled
 *  twice. */
export function normalizeSoundOverrides(
  overrides: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [presetId, on] of Object.entries(overrides)) {
    if (!on) out[presetId] = false;
  }
  return out;
}
