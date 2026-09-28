/** Cap for summaries and their error fallbacks; the build also writes it into
 *  the Swift helper (scripts/local-summary-source.cjs). */
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
