import { app, Notification, type BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { CONTROL_SOCKET_PATH } from "./paths";
import type { ControlStatusUpdate } from "./types";

type ControlRequest =
  | { type: "open"; path: string }
  | { type: "focus" }
  | {
      type: "notify";
      title?: string;
      body: string;
      terminalId?: string;
      projectSlug?: string;
    }
  | {
      type: "status";
      level: ControlStatusUpdate["level"];
      text?: string;
      terminalId?: string;
      projectSlug?: string;
      cwd?: string;
    };

interface ControlServerOptions {
  getWindow: () => BrowserWindow | null;
  openProject: (directory: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseRequest(value: unknown): ControlRequest {
  if (!isRecord(value)) throw new Error("request must be an object");
  const type = optionalString(value.type);
  if (type === "open") {
    const target = optionalString(value.path);
    if (!target) throw new Error("open.path is required");
    return { type, path: target };
  }
  if (type === "focus") return { type };
  if (type === "notify") {
    const body = optionalString(value.body);
    if (!body) throw new Error("notify.body is required");
    return {
      type,
      body,
      title: optionalString(value.title),
      terminalId: optionalString(value.terminalId),
      projectSlug: optionalString(value.projectSlug),
    };
  }
  if (type === "status") {
    const level = optionalString(value.level);
    if (
      level !== "active" &&
      level !== "waiting" &&
      level !== "done" &&
      level !== "error" &&
      level !== "clear"
    ) {
      throw new Error("status.level must be active, waiting, done, error, or clear");
    }
    return {
      type,
      level,
      text: optionalString(value.text),
      terminalId: optionalString(value.terminalId),
      projectSlug: optionalString(value.projectSlug),
      cwd: optionalString(value.cwd),
    };
  }
  throw new Error("unknown control request type");
}

function focusWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

function sendJson(socket: net.Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

async function handleRequest(
  request: ControlRequest,
  options: ControlServerOptions,
): Promise<void> {
  const win = options.getWindow();
  if (request.type === "open") {
    options.openProject(path.resolve(request.path));
    return;
  }
  if (request.type === "focus") {
    focusWindow(win);
    return;
  }
  if (request.type === "notify") {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: request.title || "Aya",
      body: request.body,
      silent: false,
    });
    notification.on("click", () => {
      const current = options.getWindow();
      focusWindow(current);
      if (
        current &&
        !current.isDestroyed() &&
        request.terminalId &&
        request.projectSlug
      ) {
        current.webContents.send("notification:select-terminal", {
          projectSlug: request.projectSlug,
          terminalId: request.terminalId,
        });
      }
    });
    notification.show();
    return;
  }
  if (request.type === "status") {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("control:status", {
      terminalId: request.terminalId,
      projectSlug: request.projectSlug,
      cwd: request.cwd,
      level: request.level,
      text: request.text,
      updatedAt: Date.now(),
    } satisfies ControlStatusUpdate);
  }
}

export function startControlServer(options: ControlServerOptions): () => void {
  fs.mkdirSync(path.dirname(CONTROL_SOCKET_PATH), { recursive: true });
  try {
    fs.rmSync(CONTROL_SOCKET_PATH, { force: true });
  } catch {
    // best effort
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 64_000) {
        sendJson(socket, { ok: false, error: "request too large" });
        socket.end();
        return;
      }
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n")).trim();
      void (async () => {
        try {
          await handleRequest(parseRequest(JSON.parse(line)), options);
          sendJson(socket, { ok: true });
        } catch (err) {
          sendJson(socket, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          socket.end();
        }
      })();
    });
  });

  server.listen(CONTROL_SOCKET_PATH, () => {
    try {
      fs.chmodSync(CONTROL_SOCKET_PATH, 0o600);
    } catch {
      // best effort
    }
  });

  const stop = () => {
    server.close();
    try {
      fs.rmSync(CONTROL_SOCKET_PATH, { force: true });
    } catch {
      // best effort
    }
  };
  app.once("before-quit", stop);
  return stop;
}
