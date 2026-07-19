// Aya Web (experimental) — client side of the WebSocket bridge protocol.
//
// Frames (JSON, one per WebSocket message):
//   client -> server  { t:"invoke", id, channel, args }
//   server -> client  { t:"result", id, ok, value|error }
//   server -> client  { t:"event", channel, payload }
//   server -> client  { t:"hello", user, platform, version, isDev }
//
// Parsing is pure and DOM-free so tests can drive it directly.

export interface WebHelloFrame {
  t: "hello";
  user: string;
  platform: string;
  version: string;
  isDev: boolean;
}

export interface WebResultFrame {
  t: "result";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface WebEventFrame {
  t: "event";
  channel: string;
  payload: unknown;
}

export type WebServerFrame = WebHelloFrame | WebResultFrame | WebEventFrame;

export function parseServerFrame(raw: unknown): WebServerFrame | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const f = parsed as Record<string, unknown>;
  if (f.t === "hello") {
    if (typeof f.user !== "string" || typeof f.version !== "string") {
      return null;
    }
    return {
      t: "hello",
      user: f.user,
      platform: typeof f.platform === "string" ? f.platform : "linux",
      version: f.version,
      isDev: f.isDev === true,
    };
  }
  if (f.t === "result") {
    if (typeof f.id !== "number" || typeof f.ok !== "boolean") return null;
    return {
      t: "result",
      id: f.id,
      ok: f.ok,
      value: f.value,
      error: typeof f.error === "string" ? f.error : undefined,
    };
  }
  if (f.t === "event") {
    if (typeof f.channel !== "string") return null;
    return { t: "event", channel: f.channel, payload: f.payload };
  }
  return null;
}

export function encodeInvokeFrame(
  id: number,
  channel: string,
  args: unknown[],
): string {
  return JSON.stringify({ t: "invoke", id, channel, args });
}
