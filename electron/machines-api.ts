// Read-only OpenAI-compatible model discovery. Never calls inference or follows redirects with a bearer token.
export interface ApiBackend {
  baseUrl: string;
  /** Public setup metadata only; the token itself stays in machines-auth.json. */
  tokenConfigured?: boolean;
}

export interface ApiState {
  up: boolean;
  models: string[] | null;
  error: string | null;
}

/** Electron's Chromium network stack is the app transport. Node fetch can be unreachable on macOS while
 *  net.fetch in the very same main process reaches the LAN. Plain Node tools/tests keep their own fetch. */
function fetchModels(url: string, init: RequestInit): Promise<Response> {
  if (process.versions.electron && process.type === "browser") {
    const { net } = require("electron") as typeof import("electron");
    return net.fetch(url, init);
  }
  return globalThis.fetch(url, init);
}

export function normalizeApiUrl(value: string): string {
  const problem = "API URL must be http(s), without credentials, query or fragment";
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(problem); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\u0000-\u0020\u007f]/.test(value)) throw new Error(problem);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath.endsWith("/v1") ? basePath : `${basePath}/v1`;
  return url.href.replace(/\/$/, "");
}

export async function probeApi(baseUrl: string, token: string | null, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ApiState> {
  const down = (error: string): ApiState => ({ up: false, models: null, error });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetchModels(`${normalizeApiUrl(baseUrl)}/models`, {
      method: "GET", redirect: "manual", credentials: "omit", signal: abort.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      await response.body?.cancel();
      return down(response.status === 401 || response.status === 403 ? "API authentication failed" : `API returned HTTP ${response.status}`);
    }
    const limit = options.maxBytes ?? 1_000_000;
    const reader = response.body?.getReader();
    if (!reader) return down("API returned no model list");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return down("API model list exceeds the size limit");
      }
      chunks.push(value);
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return down("API returned an invalid model list"); }
    const list = (data as { data?: unknown } | null)?.data;
    if (!Array.isArray(list) || list.some((m) => !m || typeof m !== "object" || typeof m.id !== "string" || !m.id.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(m.id))) return down("API returned an invalid model list");
    // A server must never get its reflected bearer credential printed as a model ID.
    if (token && list.some((m) => m.id.includes(token))) return down("API returned an invalid model list");
    return { up: true, models: [...new Set(list.map((m) => m.id as string))], error: null };
  } catch (err) {
    // No response bodies or network exception strings: either can reflect credentials.
    if (abort.signal.aborted) return down("API request timed out");
    const failure = err as { code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
    const code = failure?.cause?.code ?? failure?.code;
    // Chromium errors carry no code property. Recognize only these exact constants, never echo message text.
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || failure?.message === "net::ERR_ADDRESS_UNREACHABLE") return down("API host unreachable");
    if (code === "EACCES" || code === "EPERM" || failure?.message === "net::ERR_NETWORK_ACCESS_DENIED" || failure?.message === "net::ERR_ACCESS_DENIED") return down("API network access denied");
    return down("API not answering");
  } finally { clearTimeout(timer); }
}
