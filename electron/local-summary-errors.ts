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
  return cleaned.slice(0, 160);
}
