import type { BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { parseControlRequest, type ControlRequest } from "./control-protocol";
import {
  formatPaneList,
  listPanes,
  resolvePaneTarget,
  tailForPaneRead,
} from "./pane-target";
import { CONTROL_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import type { ControlStatusUpdate, ProjectConfig } from "./types";

// Max control-socket message size before rejecting the request (bytes).
export const CONTROL_REQUEST_MAX_SIZE_BYTES = 64_000;

/** Idle window before an unfinished request is reaped; a dispatched pane-send
 *  is exempt, so this only drops peers that never finish a frame. */
export const CONTROL_CONNECTION_IDLE_MS = 30_000;

/** Backstop linger after our FIN, for a peer still writing. */
export const CONTROL_LINGER_MS = 2_000;

/** 150 ms idle gap before pane-send's Enter: in one chunk it reads as a paste and
 *  never submits. Measured: codex-cli 0.153.4 needs 50 ms, Claude Code 120 ms. */
export const PANE_SEND_SUBMIT_DELAY_MS = 150;

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
  /** On-disk project configs, for resolving a pane name to a terminal id. */
  listProjects?: () => Promise<ProjectConfig[]>;
  /** Recent output of one pane. Backed by the pty-host's rolling buffer. */
  readPane?: (terminalId: string) => Promise<string>;
  /** Write bytes to one pane's PTY. Only `false` means not delivered; anything
   *  else - including `undefined` - counts as delivered. */
  writePane?: (terminalId: string, data: string) => Promise<boolean | void>;
  /** All live windows (and window-like sinks); status updates are broadcast
   *  because the terminal they describe may be in an unfocused window. */
  getWindows?: () => ControlStatusSink[];
  openProject: (directory: string) => void;
  /** Test-only override of the idle reap window. */
  idleTimeoutMs?: number;
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
 *  resolve their target the same way and fail loudly on an ambiguous name. */
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
  const writePane = options.writePane;
  // Serialized per terminal: the 150 ms submit gap splits a send into two
  // writes, so concurrent sends to one pane would interleave.
  return withPaneLock(terminalId, async () => {
    // Raw bytes, unlike the snippet drawer's bracketed paste: macOS bash 3.2 has
    // none and would take the markers as command text. "\r" is Enter, not "\n".
    if ((await writePane(terminalId, request.text)) === false) {
      throw new Error(
        `pane "${name}" did not accept the text - it may have exited, or be starting up with a full input queue. Nothing was submitted; check the pane before retrying.`,
      );
    }
    if (request.submit) {
      await new Promise((resolve) =>
        setTimeout(resolve, PANE_SEND_SUBMIT_DELAY_MS),
      );
      if ((await writePane(terminalId, "\r")) === false) {
        throw new Error(`pane "${name}" exited before the text was submitted`);
      }
    }
    return { terminalId, projectSlug, name };
  });
}

/** One in-flight pane-send per terminal, chained so each completes its whole
 *  text+gap+Enter sequence before the next begins. Dropped once the chain drains. */
const paneLocks = new Map<string, Promise<unknown>>();

async function withPaneLock<T>(
  terminalId: string,
  run: () => Promise<T>,
): Promise<T> {
  const prior = paneLocks.get(terminalId) ?? Promise.resolve();
  // Ignore HOW the predecessor finished: a failed send must not cancel the queue.
  const mine = prior.catch(() => {}).then(run);
  paneLocks.set(terminalId, mine);
  try {
    return await mine;
  } finally {
    // Only the last sender in the chain clears the slot.
    if (paneLocks.get(terminalId) === mine) paneLocks.delete(terminalId);
  }
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
  if (request.type === "pane-list") {
    if (!options.listProjects) throw new Error("pane control is not available");
    const projects = await options.listProjects();
    const entries = listPanes(projects, {
      projectSlug: request.projectSlug,
      selfTerminalId: request.selfTerminalId,
    });
    return { output: formatPaneList(entries) };
  }
  if (request.type === "pane-read" || request.type === "pane-send") {
    return handlePaneRequest(request, options);
  }
  if (request.type === "focus") {
    focusWindow(win);
    return;
  }
  if (request.type === "notify") {
    // Lazy: plain Node tests import this module and must not load Electron.
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

/** Boot the control server on an explicit socket path, with no Electron
 *  lifecycle dependency, so tests can drive it against a tmp socket. */
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

  // allowHalfOpen: a client that does `socket.end(frame)` FINs immediately, and
  // without this its FIN ends our writable side and drops the reply 150 ms later.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = "";
    // One request per connection; otherwise later bytes re-run the same request.
    let handled = false;
    // Answer written and our FIN sent; nothing more is owed.
    let replied = false;
    socket.setEncoding("utf8");
    // Unlistened "error" is an uncaught exception in the Electron main process.
    socket.on("error", () => {
      handled = true;
    });
    socket.on("end", () => {
      // Destroy unless we still owe a reply - that window is why allowHalfOpen is on.
      if (!handled || replied) socket.destroy();
    });
    socket.setTimeout(options.idleTimeoutMs ?? CONTROL_CONNECTION_IDLE_MS, () => {
      if (!handled) socket.destroy();
    });
    /** Reply + FIN, then let the peer drain (destroying now would EPIPE a client
     *  still pushing an oversized frame); linger backstops a peer that never ends. */
    const finish = (): void => {
      replied = true;
      socket.end();
      socket.setTimeout(CONTROL_LINGER_MS, () => socket.destroy());
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > CONTROL_REQUEST_MAX_SIZE_BYTES) {
        // handled FIRST: later chunks of the oversized frame would otherwise
        // write onto the socket we just ended (ERR_STREAM_WRITE_AFTER_END).
        handled = true;
        buffer = "";
        sendJson(socket, { ok: false, error: "request too large" });
        finish();
        return;
      }
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n")).trim();
      handled = true;
      buffer = "";
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
          finish();
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
