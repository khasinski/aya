import type { BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { parseControlRequest, type ControlRequest } from "./control-protocol";
import { resolvePaneTarget, tailForPaneRead } from "./pane-target";
import { CONTROL_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import type { ControlStatusUpdate, ProjectConfig } from "./types";

// Max control-socket message size before rejecting the request (bytes).
export const CONTROL_REQUEST_MAX_SIZE_BYTES = 64_000;

/** Anywhere a status update can be delivered: real BrowserWindows plus the
 *  Aya Web server's virtual sink (which fans out to WebSocket clients). */
export interface ControlStatusSink {
  isDestroyed(): boolean;
  webContents: {
    send(channel: "control:status", update: ControlStatusUpdate): void;
  };
}

export interface ControlServerOptions {
  /** Target for focus/notification actions (the focused/last-focused window). */
  getWindow: () => BrowserWindow | null;
  /** Project configs, used to resolve a pane name to a terminal id. Reads the
   *  on-disk configs, which is also what survives a window closing. Optional
   *  so tests can omit the pane API entirely. */
  listProjects?: () => Promise<ProjectConfig[]>;
  /** Recent output of one pane. Backed by the pty-host's rolling buffer. */
  readPane?: (terminalId: string) => Promise<string>;
  /** Write bytes to one pane's PTY, exactly as if typed. */
  writePane?: (terminalId: string, data: string) => Promise<void>;
  /** All live windows (and window-like sinks) - status updates are broadcast,
   *  because the terminal they describe may live in a window that is not
   *  focused. Each renderer ignores updates for terminals it doesn't host.
   *  Optional for tests. */
  getWindows?: () => ControlStatusSink[];
  openProject: (directory: string) => void;
}

function focusWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

function sendJson(socket: net.Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

/** pane-read / pane-send: let one terminal observe or drive another. Both
 *  resolve their target the same way and fail loudly on an ambiguous name —
 *  writing into the wrong pane is not a recoverable mistake. */
async function handlePaneRequest(
  request: Extract<ControlRequest, { type: "pane-read" | "pane-send" }>,
  options: ControlServerOptions,
): Promise<Record<string, unknown> | void> {
  if (!options.listProjects || !options.readPane || !options.writePane) {
    throw new Error("pane control is not available");
  }
  const projects = await options.listProjects();
  const resolved = resolvePaneTarget(projects, {
    terminalId: request.targetId,
    name: request.target,
    projectSlug: request.projectSlug,
  });
  if (!resolved.ok) throw new Error(resolved.error);
  const { terminalId, projectSlug, name } = resolved.match;

  if (request.type === "pane-read") {
    const output = await options.readPane(terminalId);
    return { terminalId, projectSlug, name, output: tailForPaneRead(output) };
  }
  // A carriage return is what a PTY sees when Enter is pressed; sending "\n"
  // instead leaves some TUIs with an unsubmitted line.
  await options.writePane(
    terminalId,
    request.submit ? `${request.text}\r` : request.text,
  );
  return { terminalId, projectSlug, name };
}

async function handleRequest(
  request: ControlRequest,
  options: ControlServerOptions,
): Promise<Record<string, unknown> | void> {
  const win = options.getWindow();
  if (request.type === "open") {
    options.openProject(path.resolve(request.path));
    return;
  }
  if (request.type === "pane-read" || request.type === "pane-send") {
    return handlePaneRequest(request, options);
  }
  if (request.type === "focus") {
    focusWindow(win);
    return;
  }
  if (request.type === "notify") {
    // Keep Electron out of the module's eager dependency graph. The explicit
    // socket-path server is also used by plain Node tests and must not require
    // (or trigger installation of) the Electron runtime merely when imported.
    const { Notification } = require("electron") as typeof import("electron");
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
    const update: ControlStatusUpdate = {
      terminalId: request.terminalId,
      projectSlug: request.projectSlug,
      cwd: request.cwd,
      level: request.level,
      text: request.text,
      updatedAt: Date.now(),
    };
    const targets = options.getWindows?.() ?? (win ? [win] : []);
    for (const target of targets) {
      if (!target.isDestroyed()) {
        target.webContents.send("control:status", update);
      }
    }
  }
}

/** Boot the control server on an explicit socket path. Pure: takes no Electron
 *  lifecycle dependency (no app.once), so tests can drive framing/limit/dispatch
 *  against a tmp socket. The packaged startControlServer wraps this with the
 *  canonical CONTROL_SOCKET_PATH and an app before-quit hook. */
export function startControlServerOn(
  socketPath: string,
  options: ControlServerOptions,
): () => void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // best effort
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > CONTROL_REQUEST_MAX_SIZE_BYTES) {
        sendJson(socket, { ok: false, error: "request too large" });
        socket.end();
        return;
      }
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n")).trim();
      void (async () => {
        try {
          const payload = await handleRequest(
            parseControlRequest(JSON.parse(line)),
            options,
          );
          sendJson(socket, { ok: true, ...(payload ?? {}) });
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

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, SOCKET_FILE_PERMISSIONS);
    } catch {
      // best effort
    }
  });

  return () => {
    server.close();
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // best effort
    }
  };
}

export function startControlServer(options: ControlServerOptions): () => void {
  const { app } = require("electron") as typeof import("electron");
  const stop = startControlServerOn(CONTROL_SOCKET_PATH, options);
  app.once("before-quit", stop);
  return stop;
}
