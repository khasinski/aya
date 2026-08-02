/** Cap for summary-ish strings surfaced to the renderer (model summaries and
 *  their error fallbacks share it - main.ts imports this for the former). */
export const SUMMARY_TEXT_MAX_CHARS = 160;

export function normalizeLocalSummaryError(error?: string): string | undefined {
  if (!error) return undefined;
  const cleaned = error.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  if (
    cleaned.includes("assetsUnavailable") ||
    cleaned.includes("Model is unavailable")
  ) {
    return "apple-model-unavailable";
  }
  if (cleaned.includes("spawn ENOTDIR")) return "helper-not-executable";
  return cleaned.slice(0, SUMMARY_TEXT_MAX_CHARS);
}
