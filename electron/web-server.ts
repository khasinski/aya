// Aya Web (experimental) — password-protected browser access to Aya.
//
// A plain HTTP + WebSocket server hosted by the Electron main process:
//   GET  /            the web build of the renderer (dist/web.html)
//   POST /api/login   { user, password } -> HttpOnly session cookie
//   POST /api/logout
//   GET  /api/me      200 when the session cookie is valid, else 401
//   GET  /ws          WebSocket carrying the window.aya bridge:
//                     client  { t:"invoke", id, channel, args }
//                     server  { t:"result", id, ok, value|error }
//                     server  { t:"event", channel, payload }   (push)
//                     server  { t:"hello", ... }                (on connect)
//
// Invokes are dispatched to the SAME ipcMain handlers the desktop renderer
// uses (captured in web-ipc.ts). Channels whose handler is window-scoped are
// overridden below with their windowless semantics — the same null-window
// path projects:state already documents for the remote server.
//
// SECURITY: sessions are in-memory (restart = re-login), the cookie is
// HttpOnly + SameSite=Strict, login is rate-limited per client address, and
// browser requests must carry a same-host Origin. There is no TLS — the
// server is meant to be reached over a trusted network (LAN, Tailscale,
// WireGuard or an SSH tunnel), which the Settings UI says out loud.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { listProjectState, saveProjectState } from "./config";
import { validateProjectCollectionState } from "./validation";
import { verifyWebPassword, type WebConfig } from "./web-config";
import {
  hasCapturedIpcHandler,
  invokeCapturedIpcHandler,
} from "./web-ipc";

const SESSION_COOKIE = "aya_web_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_BODY_MAX_BYTES = 4096;
const WS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
// Failed-login throttle: per client address, sliding window.
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

export interface WebServerOptions {
  appVersion: string;
  isDev: boolean;
  /** Directory with the built renderer (contains web.html + assets/). */
  distDir: string;
  /** Read the CURRENT config — credential edits apply without a restart. */
  getConfig: () => WebConfig;
}

export interface WebServerHandle {
  port: number;
  host: string;
  /** Push an event frame to every authenticated client. */
  broadcast(channel: string, payload: unknown): void;
  clientCount(): number;
  close(): Promise<void>;
}

interface Session {
  user: string;
  expiresAt: number;
}

// Channels whose desktop handler needs a BrowserWindow. The web client stubs
// most of these locally, but a raw WS client may still send them — every one
// must degrade to its windowless meaning instead of reaching a null sender.
const CHANNEL_OVERRIDES: Record<
  string,
  (args: unknown[]) => Promise<unknown>
> = {
  // Web sessions see the full on-disk state, not a per-window slice.
  "projects:state": async () => listProjectState(),
  "projects:save-state": async (args) =>
    saveProjectState(validateProjectCollectionState(args[0])),
  "windows:list-others": async () => [],
  "windows:resolve-drop": async () => ({ kind: "self" }),
  "windows:adopt-project": async () => {
    throw new Error("Multi-window is not available in Aya Web");
  },
  "env:pick-dir": async () => null,
  "env:pick-sound": async () => null,
  "themes:import": async () => null,
  "app:is-fullscreen": async () => false,
  "app:is-maximized": async () => false,
  "app:minimize": async () => undefined,
  "app:toggle-maximize": async () => undefined,
  "app:close": async () => undefined,
  "app:set-fullscreen": async () => undefined,
  "app:focus-window": async () => undefined,
  "app:notify-waiting": async () => undefined,
  "app:set-dock-badge": async () => undefined,
};

export async function dispatchWebInvoke(
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const override = CHANNEL_OVERRIDES[channel];
  if (override) return override(args);
  if (!hasCapturedIpcHandler(channel)) {
    throw new Error(`Unknown channel: ${channel}`);
  }
  return invokeCapturedIpcHandler(channel, args);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/** Browser cross-site requests carry an Origin; require it to match the Host
 *  we were addressed by. Requests without an Origin (curl, same-origin GETs)
 *  pass — they can't ride an ambient browser session cross-site. */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export async function startWebServer(
  options: WebServerOptions,
): Promise<WebServerHandle> {
  const sessions = new Map<string, Session>();
  const loginFailures = new Map<string, { count: number; resetAt: number }>();
  const clients = new Set<WebSocket>();

  const sessionFor = (req: http.IncomingMessage): Session | null => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      return null;
    }
    // Sliding expiry — an actively used session stays alive.
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  };

  const throttled = (address: string): boolean => {
    const entry = loginFailures.get(address);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      loginFailures.delete(address);
      return false;
    }
    return entry.count >= LOGIN_FAILURE_LIMIT;
  };

  const recordFailure = (address: string): void => {
    const now = Date.now();
    const entry = loginFailures.get(address);
    if (!entry || entry.resetAt < now) {
      loginFailures.set(address, {
        count: 1,
        resetAt: now + LOGIN_FAILURE_WINDOW_MS,
      });
      return;
    }
    entry.count += 1;
  };

  const handleLogin = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    if (!originAllowed(req)) {
      sendJson(res, 403, { error: "bad_origin" });
      return;
    }
    const address = req.socket.remoteAddress ?? "unknown";
    if (throttled(address)) {
      sendJson(res, 429, { error: "too_many_attempts" });
      return;
    }
    const body = await readBody(req, LOGIN_BODY_MAX_BYTES);
    let parsed: unknown = null;
    try {
      parsed = body === null ? null : JSON.parse(body);
    } catch {
      parsed = null;
    }
    const creds =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const user = typeof creds.user === "string" ? creds.user : "";
    const password = typeof creds.password === "string" ? creds.password : "";
    const config = options.getConfig();
    const ok = user === config.user && verifyWebPassword(config, password);
    if (!ok) {
      recordFailure(address);
      sendJson(res, 401, { error: "invalid_credentials" });
      return;
    }
    loginFailures.delete(address);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    sendJson(
      res,
      200,
      { ok: true, user },
      {
        "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      },
    );
  };

  const serveStatic = (
    res: http.ServerResponse,
    urlPath: string,
  ): void => {
    const relative = urlPath === "/" ? "web.html" : urlPath.slice(1);
    const resolved = path.normalize(path.join(options.distDir, relative));
    // Traversal guard: the resolved path must stay inside distDir.
    if (!resolved.startsWith(options.distDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        // Hashed asset filenames may cache forever; entry points must not.
        "Cache-Control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-store",
      });
      res.end(data);
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "aya"}`);
    if (req.method === "POST" && url.pathname === "/api/login") {
      void handleLogin(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) sessions.delete(token);
      sendJson(res, 200, { ok: true }, {
        "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/me") {
      const session = sessionFor(req);
      if (!session) {
        sendJson(res, 401, { error: "unauthenticated" });
        return;
      }
      sendJson(res, 200, {
        user: session.user,
        platform: process.platform,
        version: options.appVersion,
      });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(res, url.pathname);
      return;
    }
    res.writeHead(405).end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "aya"}`);
    if (url.pathname !== "/ws" || !originAllowed(req) || !sessionFor(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const session = sessionFor(req);
    if (!session) {
      ws.close();
      return;
    }
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
    ws.send(
      JSON.stringify({
        t: "hello",
        user: session.user,
        platform: process.platform,
        version: options.appVersion,
        isDev: options.isDev,
      }),
    );
    ws.on("message", (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof frame !== "object" || frame === null) return;
      const f = frame as Record<string, unknown>;
      if (f.t !== "invoke") return;
      const id = f.id;
      const channel = f.channel;
      const args = Array.isArray(f.args) ? f.args : [];
      if (typeof id !== "number" || typeof channel !== "string") return;
      void dispatchWebInvoke(channel, args)
        .then((value) => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify({ t: "result", id, ok: true, value }));
        })
        .catch((err: unknown) => {
          if (ws.readyState !== ws.OPEN) return;
          const message = err instanceof Error ? err.message : String(err);
          ws.send(
            JSON.stringify({ t: "result", id, ok: false, error: message }),
          );
        });
    });
  });

  const config = options.getConfig();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // The actual bound port (config.port === 0 asks the OS for one — tests).
  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : config.port;

  return {
    port: boundPort,
    host: config.host,
    broadcast(channel, payload) {
      if (clients.size === 0) return;
      const frame = JSON.stringify({ t: "event", channel, payload });
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(frame);
      }
    },
    clientCount: () => clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of clients) ws.terminate();
        clients.clear();
        wss.close();
        server.close(() => resolve());
        sessions.clear();
      }),
  };
}
