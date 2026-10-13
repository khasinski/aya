import type { AyaIntelligenceConfig } from "./types";
import { OLLAMA_OPENAI_BASE_URL, RECOMMENDED_OLLAMA_MODEL } from "./ollama-defaults";
import { AYA_INTELLIGENCE_STORAGE_KEY, LOCAL_SUMMARY_CACHE_STORAGE_KEY } from "./storage-keys";

// Stable empty map handed to chrome when summaries are off, so the prop doesn't
// change identity every render (a fresh `{}` would defeat child memoization).
export const EMPTY_SUMMARIES: Record<string, string> = {};

export const LOCAL_SUMMARY_REFRESH_MS = 30 * 60 * 1000;
export const LOCAL_SUMMARY_DEBOUNCE_MS = 10_000;
export const LOCAL_SUMMARY_MIN_UPDATE_MS = 2 * 60 * 1000;
export const LOCAL_SUMMARY_MIN_NEW_LINES = 8;
// Fewer output lines than this are "not enough output" to summarize.
export const LOCAL_SUMMARY_MIN_LINES = 2;
// Cleaned output lines shorter than this (prompts, stray glyphs) are dropped.
export const LOCAL_SUMMARY_MIN_LINE_CHARS = 3;
export const LOCAL_SUMMARY_BUFFER_LINES = 80;
export const LOCAL_SUMMARY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_AYA_INTELLIGENCE: AyaIntelligenceConfig = {
  provider: "apple",
  ollamaModel: RECOMMENDED_OLLAMA_MODEL,
  openAiBaseUrl: OLLAMA_OPENAI_BASE_URL,
  openAiApiKey: "",
  openAiModel: RECOMMENDED_OLLAMA_MODEL,
};

export interface AutoSummaryStatus {
  terminalCount: number;
  terminalsWithLines: number;
  totalLines: number;
  lastEvent: string;
}

export interface SummaryCache {
  terminal: Record<string, { summary: string; updatedAt: number }>;
  project: Record<string, { summary: string; updatedAt: number }>;
}

export function readSummaryCache(): SummaryCache {
  try {
    const raw = localStorage.getItem(LOCAL_SUMMARY_CACHE_STORAGE_KEY);
    if (!raw) return { terminal: {}, project: {} };
    const parsed = JSON.parse(raw) as Partial<SummaryCache>;
    const now = Date.now();
    const normalize = (
      input: unknown,
    ): Record<string, { summary: string; updatedAt: number }> => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return {};
      }
      const out: Record<string, { summary: string; updatedAt: number }> = {};
      for (const [key, value] of Object.entries(input)) {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          continue;
        }
        const entry = value as Record<string, unknown>;
        if (
          typeof entry.summary !== "string" ||
          !entry.summary.trim() ||
          typeof entry.updatedAt !== "number" ||
          now - entry.updatedAt > LOCAL_SUMMARY_CACHE_MAX_AGE_MS
        ) {
          continue;
        }
        out[key] = { summary: entry.summary.trim(), updatedAt: entry.updatedAt };
      }
      return out;
    };
    return {
      terminal: normalize(parsed.terminal),
      project: normalize(parsed.project),
    };
  } catch {
    return { terminal: {}, project: {} };
  }
}

export function summariesFromCache(
  cache: SummaryCache,
  kind: "terminal" | "project",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cache[kind]).map(([key, value]) => [key, value.summary]),
  );
}

export function readAyaIntelligenceConfig(): AyaIntelligenceConfig {
  try {
    const raw = localStorage.getItem(AYA_INTELLIGENCE_STORAGE_KEY);
    if (!raw) return DEFAULT_AYA_INTELLIGENCE;
    const parsed = JSON.parse(raw) as Partial<AyaIntelligenceConfig>;
    return {
      provider:
        parsed.provider === "ollama" || parsed.provider === "openai"
          ? parsed.provider
          : "apple",
      ollamaModel:
        typeof parsed.ollamaModel === "string" && parsed.ollamaModel.trim()
          ? parsed.ollamaModel.trim()
          : DEFAULT_AYA_INTELLIGENCE.ollamaModel,
      openAiBaseUrl:
        typeof parsed.openAiBaseUrl === "string"
          ? parsed.openAiBaseUrl
          : DEFAULT_AYA_INTELLIGENCE.openAiBaseUrl,
      openAiApiKey:
        typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : "",
      openAiModel:
        typeof parsed.openAiModel === "string" && parsed.openAiModel.trim()
          ? parsed.openAiModel.trim()
          : DEFAULT_AYA_INTELLIGENCE.openAiModel,
    };
  } catch {
    return DEFAULT_AYA_INTELLIGENCE;
  }
}

export function cleanTerminalOutput(chunk: string): string[] {
  return chunk
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length >= LOCAL_SUMMARY_MIN_LINE_CHARS);
}

export function summaryHash(lines: string[]): string {
  let hash = 2166136261;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return String(hash >>> 0);
}

