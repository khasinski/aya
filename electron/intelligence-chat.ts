// One chat call to Aya Intelligence over HTTP (Ollama or OpenAI-compatible),
// shared by terminal summaries and team role drafts.

export const OLLAMA_BASE_URL = "http://localhost:11434";

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
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
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
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
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
