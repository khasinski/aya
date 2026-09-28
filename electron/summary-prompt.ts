import type { LocalSummaryRequest, LocalSummaryResult } from "./types";

// Title fallback caps (first-line words / chars) for the local summary.
const SUMMARY_TITLE_MAX_WORDS = 8;
const SUMMARY_TITLE_MAX_CHARS = 80;

function cleanSummary(value: string): string {
  const oneLine = value
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim();
  const words = oneLine.split(/\s+/).filter(Boolean).slice(0, SUMMARY_TITLE_MAX_WORDS).join(" ");
  return words.slice(0, SUMMARY_TITLE_MAX_CHARS);
}

export function summaryPrompt(req: LocalSummaryRequest): string {
  const subject =
    req.kind === "project" ? "project activity" : "terminal output";
  return [
    `Summarize recent ${subject} for a compact app label.`,
    "Return strict JSON only, with shape:",
    '{"useful":true,"summary":"2-6 word label"}',
    "If the output is too noisy, generic, idle, or not meaningful, return:",
    '{"useful":false,"summary":""}',
    "Do not invent context. No full sentences. No punctuation. Max 6 words.",
    "",
    "Recent output:",
    req.lines.join("\n"),
  ].join("\n");
}

export function parseSummaryResponse(content: string): LocalSummaryResult {
  const trimmed = content.trim();
  const jsonText =
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as Partial<LocalSummaryResult>;
    const summary =
      typeof parsed.summary === "string" ? cleanSummary(parsed.summary) : "";
    return {
      available: true,
      useful: parsed.useful === true && summary.length > 0,
      summary: parsed.useful === true ? summary : "",
    };
  } catch {
    const summary = cleanSummary(trimmed);
    return { available: true, useful: summary.length > 0, summary };
  }
}
