import { PRESET_ID_CODEX, PRESET_ID_GEMINI } from "./preset-ids";

const SCROLLBACK_PRESERVING_PRESET_IDS = new Set([PRESET_ID_CODEX]);

// Gemini redraws its prompt/status region aggressively enough that xterm's
// WebGL canvas can flicker on prompt-line updates. Keep opencode on WebGL:
// its block-heavy UI shows 1px glyph seams in the DOM renderer.
const WEBGL_DISABLED_PRESET_IDS = new Set([PRESET_ID_GEMINI]);

export function shouldUseTerminalWebgl(
  enableWebgl: boolean,
  presetId: string,
): boolean {
  return enableWebgl && !WEBGL_DISABLED_PRESET_IDS.has(presetId);
}

export function shouldPreserveTerminalScrollback(presetId: string): boolean {
  return SCROLLBACK_PRESERVING_PRESET_IDS.has(presetId);
}

export function stripScrollbackErase(chunk: string): string {
  return chunk.replace(/\x1b\[(?:3|\?3)J/g, "");
}

/** Render SGR "dashed underline" (4:5) as a regular solid underline.
 *
 * Codex uses this style for OSC 8/Markdown links. A CSS override only affects
 * xterm's DOM renderer; normalizing the SGR sequence also covers WebGL.
 */
export function normalizeTerminalLinkUnderline(chunk: string): string {
  return chunk.replace(/\x1b\[([0-9:;]*)m/g, (sequence, parameters: string) => {
    if (!parameters.split(";").includes("4:5")) return sequence;
    return `\x1b[${parameters
      .split(";")
      .map((parameter) => (parameter === "4:5" ? "4" : parameter))
      .join(";")}m`;
  });
}
