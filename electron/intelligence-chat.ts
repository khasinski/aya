// One chat call to Aya Intelligence over HTTP (Ollama or OpenAI-compatible),
// shared by terminal summaries and team role drafts.

import { spawn } from "node:child_process";
import type { AyaIntelligenceConfig } from "./types";

export const OLLAMA_BASE_URL = "http://localhost:11434";
/** Ollama's OpenAI-compatible endpoint (the renderer's default openAiBaseUrl). */
export const OLLAMA_OPENAI_BASE_URL = `${OLLAMA_BASE_URL}/v1`;
/** The default ollamaModel and the model the Ollama status recommends. */
export const RECOMMENDED_OLLAMA_MODEL = "gemma4:e4b";

export type ChatResult = { ok: true; content: string } | { ok: false; error: string };

export interface ChatOptions {
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export function openAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function messages(system: string, user: string) {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  httpError: string,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, error: `${httpError}-${response.status}` };
    return { ok: true, json: await response.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function ollamaChat(
  model: string,
  system: string,
  user: string,
  opts: ChatOptions,
  baseUrl: string = OLLAMA_BASE_URL,
): Promise<ChatResult> {
  const result = await post(
    `${baseUrl}/api/chat`,
    {},
    {
      model,
      stream: false,
      think: false,
      messages: messages(system, user),
      options: { temperature: opts.temperature, num_predict: opts.maxTokens },
    },
    opts.timeoutMs,
    "ollama-http",
  );
  if (!result.ok) return result;
  const content = (result.json as { message?: { content?: unknown } }).message?.content;
  return { ok: true, content: typeof content === "string" ? content : "" };
}

export async function openAiChat(
  api: { baseUrl: string; apiKey?: string; model: string },
  system: string,
  user: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  const baseUrl = openAiBaseUrl(api.baseUrl);
  const model = api.model.trim();
  if (!baseUrl || !model) return { ok: false, error: "missing-api-config" };
  const result = await post(
    `${baseUrl}/chat/completions`,
    api.apiKey ? { Authorization: `Bearer ${api.apiKey}` } : {},
    {
      model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      think: false,
      messages: messages(system, user),
    },
    opts.timeoutMs,
    "api-http",
  );
  if (!result.ok) return result;
  const choice = (result.json as { choices?: Array<{ message?: { content?: unknown; reasoning?: unknown }; text?: unknown }> })
    .choices?.[0];
  const message = choice?.message;
  const content =
    typeof message?.content === "string"
      ? message.content || (typeof message.reasoning === "string" ? message.reasoning : "")
      : typeof choice?.text === "string"
        ? choice.text
        : "";
  return { ok: true, content };
}

/** One chat with the HTTP provider a config names: Ollama or OpenAI-compatible. */
export function providerChat(
  intelligence: AyaIntelligenceConfig,
  system: string,
  user: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  return intelligence.provider === "ollama"
    ? ollamaChat(intelligence.ollamaModel, system, user, opts)
    : openAiChat(
        { baseUrl: intelligence.openAiBaseUrl, apiKey: intelligence.openAiApiKey, model: intelligence.openAiModel },
        system,
        user,
        opts,
      );
}

/** Apple Intelligence through the bundled Swift helper's "chat" request. */
/** How much of the Apple helper's stdout is read; a chat or summary reply is a few KB. */
export const APPLE_HELPER_STDOUT_MAX_BYTES = 32 * 1024;

export function appleChat(helper: string, system: string, user: string, opts: ChatOptions): Promise<ChatResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (result: ChatResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: "timeout" });
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length <= APPLE_HELPER_STDOUT_MAX_BYTES) return;
      child.kill("SIGKILL");
      finish({ ok: false, error: "helper-output-too-large" });
    });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", () => {
      try {
        const reply = JSON.parse(stdout) as { available?: unknown; text?: unknown; error?: unknown };
        if (reply.available === true && typeof reply.text === "string") finish({ ok: true, content: reply.text });
        else finish({ ok: false, error: typeof reply.error === "string" && reply.error ? reply.error : "unavailable" });
      } catch {
        finish({ ok: false, error: "invalid-helper-json" });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ kind: "chat", lines: [], system, prompt: user }));
  });
}
