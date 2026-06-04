const SCROLLBACK_PRESERVING_PRESET_IDS = new Set([
  "codex",
]);

// Gemini redraws its prompt/status region aggressively enough that xterm's
// WebGL canvas can flicker on prompt-line updates. Keep opencode on WebGL:
// its block-heavy UI shows 1px glyph seams in the DOM renderer.
const WEBGL_DISABLED_PRESET_IDS = new Set(["gemini"]);

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
