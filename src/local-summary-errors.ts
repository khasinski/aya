import type { AyaIntelligenceProvider } from "./types";

export function localSummaryUnavailableMessage(
  error: string | undefined,
  provider: AyaIntelligenceProvider,
): string {
  if (provider === "apple") {
    if (
      error === "apple-model-unavailable" ||
      error?.includes("assetsUnavailable") ||
      error?.includes("Model is unavailable")
    ) {
      return "Apple Intelligence model unavailable on this Mac.";
    }
    if (error === "helper-missing") {
      return "Apple Intelligence helper is missing from this Aya build.";
    }
    if (error === "helper-not-executable") {
      return "Apple Intelligence helper could not be launched.";
    }
    if (error === "unsupported-platform" || error === "unsupported-macos") {
      return "Apple Intelligence is not available on this macOS version.";
    }
    return error
      ? `Apple Intelligence unavailable: ${error}.`
      : "Apple Intelligence unavailable.";
  }
  if (provider === "ollama") {
    return error ? `Ollama unavailable: ${error}.` : "Ollama unavailable.";
  }
  return error ? `API unavailable: ${error}.` : "API unavailable.";
}
