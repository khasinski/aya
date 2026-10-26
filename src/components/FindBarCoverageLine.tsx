import type { HarnessSearchResult } from "../types";
import { formatHarnessSearchCoverage } from "../harness-search-coverage";

interface Props {
  coverage: HarnessSearchResult["coverage"];
  hasHits: boolean;
  agentLabel: "Claude" | "Codex";
}

export function FindBarCoverageLine({ coverage, hasHits, agentLabel }: Props) {
  const text = formatHarnessSearchCoverage(coverage, hasHits, agentLabel);
  if (!text) return null;
  return <div className="aya-findbar-coverage">{text}</div>;
}
