// Local terminal summaries and Ollama status and installation for Aya Intelligence.

import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { bundledDistElectronHelperPath } from "./cli-path";
import { COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import {
  type ChatResult,
  APPLE_HELPER_STDOUT_MAX_BYTES,
  OLLAMA_BASE_URL,
  providerChat,
  RECOMMENDED_OLLAMA_MODEL,
} from "./intelligence-chat";
import {
  LOCAL_SUMMARY_MAX_LINES,
  normalizeLocalSummaryError,
  SUMMARY_TEXT_MAX_CHARS,
} from "./local-summary-errors";
import { parseSummaryResponse, summaryPrompt } from "./summary-prompt";
import type { AyaIntelligenceConfig, LocalSummaryRequest, LocalSummaryResult, OllamaStatus } from "./types";
import { requireString } from "./validation";

export interface AyaIntelligenceDeps {
  /** The live process PATH, owned by main.ts and repaired during startup. */
  findExecutableOnPath: (name: string) => string | null;
  /** Stand-ins for the platform, filesystem, child processes and HTTP providers in tests. */
  platform?: () => NodeJS.Platform;
  access?: typeof fs.access;
  spawn?: typeof spawn;
  fetch?: typeof fetch;
  providerChat?: typeof providerChat;
}

const LOCAL_SUMMARY_TIMEOUT_MS = 20_000;
// Summarizer sampling knobs, shared by BOTH backends (OpenAI-compatible and
// Ollama) - the two request builders must stay in sync.
const SUMMARY_TEMPERATURE = 0.2;
const SUMMARY_MAX_TOKENS = 64;
// Bound captured `ollama pull` stderr so a chatty child can't balloon memory.
const OLLAMA_PULL_STDERR_MAX_BYTES = 8192;
// Max accepted Ollama model-name length (IPC input-validation cap).
const OLLAMA_MODEL_NAME_MAX_LEN = 120;
const OLLAMA_MODEL_NAME_RE = new RegExp(`^[A-Za-z0-9._:/-]{1,${OLLAMA_MODEL_NAME_MAX_LEN}}$`);

export function unavailableLocalSummary(error?: string): LocalSummaryResult {
  const normalized = normalizeLocalSummaryError(error);
  return {
    available: false,
    useful: false,
    summary: "",
    ...(normalized ? { error: normalized } : {}),
  };
}

export function normalizeAyaIntelligenceConfig(
  value: unknown,
): AyaIntelligenceConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const provider =
    input.provider === "ollama" || input.provider === "openai"
      ? input.provider
      : "apple";
  return {
    provider,
    ollamaModel:
      typeof input.ollamaModel === "string" && input.ollamaModel.trim()
        ? input.ollamaModel.trim()
        : RECOMMENDED_OLLAMA_MODEL,
    openAiBaseUrl:
      typeof input.openAiBaseUrl === "string" ? input.openAiBaseUrl.trim() : "",
    openAiApiKey:
      typeof input.openAiApiKey === "string" ? input.openAiApiKey.trim() : "",
    openAiModel:
      typeof input.openAiModel === "string" ? input.openAiModel.trim() : "",
  };
}

export function validateLocalSummaryRequest(value: unknown): LocalSummaryRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("local-summary:summarize.req must be an object");
  }
  const req = value as Record<string, unknown>;
  const kind = req.kind === "project" ? "project" : "terminal";
  if (!Array.isArray(req.lines)) {
    throw new Error("local-summary:summarize.lines must be an array");
  }
  const lines = req.lines
    .filter((line): line is string => typeof line === "string")
    .slice(-LOCAL_SUMMARY_MAX_LINES);
  return {
    kind,
    lines,
    ...(req.intelligence
      ? { intelligence: normalizeAyaIntelligenceConfig(req.intelligence) }
      : {}),
  };
}

/** The bundled Apple Foundation Models helper (no e2e override). */
export function appleHelperPath(): string {
  return bundledDistElectronHelperPath(__dirname, "aya-local-summary");
}

export async function summarizeWithApple(
  deps: AyaIntelligenceDeps,
  req: LocalSummaryRequest,
): Promise<LocalSummaryResult> {
  if ((deps.platform?.() ?? process.platform) !== "darwin") return unavailableLocalSummary("unsupported-platform");
  const helper = appleHelperPath();
  try {
    await (deps.access ?? fs.access)(helper, fsConstants.X_OK);
  } catch {
    return unavailableLocalSummary("helper-missing");
  }

  return new Promise((resolve) => {
    const child = (deps.spawn ?? spawn)(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(unavailableLocalSummary("timeout"));
    }, LOCAL_SUMMARY_TIMEOUT_MS);

    const finish = (result: LocalSummaryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < APPLE_HELPER_STDOUT_MAX_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < APPLE_HELPER_STDOUT_MAX_BYTES) stderr += chunk;
    });
    child.on("error", (error) => finish(unavailableLocalSummary(error.message)));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(unavailableLocalSummary(stderr.trim() || `helper-exit-${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as Partial<LocalSummaryResult>;
        const summary =
          typeof parsed.summary === "string"
            ? parsed.summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_TEXT_MAX_CHARS)
            : "";
        finish({
          available: parsed.available === true,
          useful: parsed.useful === true && summary.length > 0,
          summary: parsed.useful === true ? summary : "",
          ...(typeof parsed.error === "string" && parsed.error
            ? { error: normalizeLocalSummaryError(parsed.error) }
            : {}),
        });
      } catch {
        finish(unavailableLocalSummary("invalid-helper-json"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(req));
  });
}

const SUMMARY_SYSTEM = "You summarize terminal output for a developer tool. Return JSON only.";
const SUMMARY_CHAT = {
  temperature: SUMMARY_TEMPERATURE,
  maxTokens: SUMMARY_MAX_TOKENS,
  timeoutMs: LOCAL_SUMMARY_TIMEOUT_MS,
};

export function summaryFromChat(result: ChatResult): LocalSummaryResult {
  if (!result.ok) return unavailableLocalSummary(result.error);
  if (!result.content) return { available: true, useful: false, summary: "" };
  return parseSummaryResponse(result.content);
}

export async function summarizeLocal(
  deps: AyaIntelligenceDeps,
  req: LocalSummaryRequest,
): Promise<LocalSummaryResult> {
  const intelligence = req.intelligence;
  if (!intelligence || intelligence.provider === "apple") {
    return summarizeWithApple(deps, req);
  }
  return summaryFromChat(await (deps.providerChat ?? providerChat)(intelligence, SUMMARY_SYSTEM, summaryPrompt(req), SUMMARY_CHAT));
}

export async function ollamaStatus(
  deps: AyaIntelligenceDeps,
  recommendedModel = RECOMMENDED_OLLAMA_MODEL,
): Promise<OllamaStatus> {
  const executable = deps.findExecutableOnPath("ollama");
  if (!executable) {
    return {
      installed: false,
      running: false,
      path: null,
      models: [],
      recommendedModel,
      recommendedModelInstalled: false,
      message: "Ollama is not installed or not on PATH.",
    };
  }
  try {
    const response = await (deps.fetch ?? fetch)(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(COMMAND_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        installed: true,
        running: false,
        path: executable,
        models: [],
        recommendedModel,
        recommendedModelInstalled: false,
        message: `Ollama API returned HTTP ${response.status}.`,
      };
    }
    const json = (await response.json()) as {
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    const models = (Array.isArray(json.models) ? json.models : [])
      .map((model) =>
        typeof model.name === "string"
          ? model.name
          : typeof model.model === "string"
            ? model.model
            : "",
      )
      .filter(Boolean);
    return {
      installed: true,
      running: true,
      path: executable,
      models,
      recommendedModel,
      recommendedModelInstalled: models.includes(recommendedModel),
    };
  } catch (err) {
    return {
      installed: true,
      running: false,
      path: executable,
      models: [],
      recommendedModel,
      recommendedModelInstalled: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function validateOllamaModelName(value: unknown): string {
  const model = requireString(value, "intelligence:pull-ollama-model.model").trim();
  if (!OLLAMA_MODEL_NAME_RE.test(model)) {
    throw new Error("Ollama model name contains unsupported characters.");
  }
  return model;
}

export async function pullOllamaModel(deps: AyaIntelligenceDeps, model: string): Promise<OllamaStatus> {
  const executable = deps.findExecutableOnPath("ollama");
  if (!executable) throw new Error("Ollama is not installed or not on PATH.");
  await new Promise<void>((resolve, reject) => {
    const child = (deps.spawn ?? spawn)(executable, ["pull", model], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < OLLAMA_PULL_STDERR_MAX_BYTES) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ollama pull exited ${code}`));
    });
  });
  return ollamaStatus(deps, model);
}
