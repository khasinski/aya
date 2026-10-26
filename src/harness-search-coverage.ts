import type { HarnessSearchResult } from "./types";

/** User-facing coverage copy shared by the History results and renderer tests. */
export function formatHarnessSearchCoverage(
  coverage: HarnessSearchResult["coverage"],
  hasHits: boolean,
  agentLabel: "Claude" | "Codex",
  formatDate: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): string | null {
  if (!coverage.partial) return null;
  if (!coverage.searchedBackTo) {
    return `Search timed out before reading recent ${agentLabel} sessions`;
  }
  const date = formatDate(coverage.searchedBackTo);
  const message = hasHits
    ? `Searched back to ${date} in long sessions`
    : `No matches since ${date} in recent ${agentLabel} sessions for this directory`;
  return coverage.longMessagesSkipped
    ? `${message} (very long messages were not searched)`
    : message;
}
