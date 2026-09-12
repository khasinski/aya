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

/** How long a connection may sit without completing a request before we drop
 *  it. Generous, because a pane-send legitimately holds its socket open across
 *  the submit gap - this only reaps peers that never finish a frame. */
export const CONTROL_CONNECTION_IDLE_MS = 30_000;

/** How long we linger after answering, so a peer that is still writing can
 *  drain and read the reply before we close. Only a backstop - a well-behaved
 *  client's FIN closes the socket at once. */
export const CONTROL_LINGER_MS = 2_000;

/** Idle gap between a pane-send's text and the Enter that submits it (ms).
 *
 *  pane-send used to write `${text}\r` as ONE chunk, and the agent TUIs did
 *  not submit it: the Codex and Claude Code composers treat a burst of
 *  characters arriving together as a paste, so the trailing carriage return
 *  lands inside the pasted block and becomes a newline in the message box
 *  instead of Enter. The text appeared in the composer and just sat there.
 *
 *  Letting the burst go idle before the CR is what makes it read as a real
 *  keypress. Measured by driving both TUIs through a pty: one chunk never
 *  submitted (Claude's composer even dropped characters from the burst),
 *  while a separate CR submitted at every gap tried - 50 ms sufficed for
 *  codex-cli 0.153.4 and 120 ms for Claude Code, so 150 ms leaves margin.
 *
 *  Bracketed paste is deliberately NOT used here, even though the snippet
 *  drawer wraps its text that way: pane-send targets any pane, and a shell
 *  without bracketed-paste support (macOS /bin/sh and /bin/bash are bash
 *  3.2) inserts the markers as literal text - measured as
 *  `bash: 00~echo: command not found`. Raw bytes type correctly everywhere. */
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
  /** Project configs, used to resolve a pane name to a terminal id. Reads the
   *  on-disk configs, which is also what survives a window closing. Optional
   *  so tests can omit the pane API entirely. */
  listProjects?: () => Promise<ProjectConfig[]>;
  /** Recent output of one pane. Backed by the pty-host's rolling buffer. */
  readPane?: (terminalId: string) => Promise<string>;
  /** Write bytes to one pane's PTY, exactly as if typed. Resolving `false`
   *  means the bytes went nowhere (no live process for that id) and pane-send
   *  reports a failure; anything else - including `undefined` - is delivered,
   *  so a host that cannot tell is never turned into a spurious error. */
  writePane?: (terminalId: string, data: string) => Promise<boolean | void>;
  /** All live windows (and window-like sinks) - status updates are broadcast,
   *  because the terminal they describe may live in a window that is not
   *  focused. Each renderer ignores updates for terminals it doesn't host.
   *  Optional for tests. */
  getWindows?: () => ControlStatusSink[];
  openProject: (directory: string) => void;
  /** Override the idle window before an unfinished connection is reaped.
   *  Only for tests - waiting out the real 30 s is not a test. */
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
  const writePane = options.writePane;
  // Serialized per terminal: the submit gap below makes a pane-send span two
  // writes with 150 ms of yield between them, so two concurrent sends to one
  // pane would otherwise interleave into a single merged line plus a stray
  // Enter. `pane list` exists to let agents find each other's panes, so
  // concurrent sends are the expected traffic, not an exotic case.
  return withPaneLock(terminalId, async () => {
    // Text first, then the Enter as its OWN write after an idle gap - see
    // PANE_SEND_SUBMIT_DELAY_MS for why one combined chunk does not submit.
    // "\r" is what a PTY sees when Enter is pressed; "\n" instead leaves some
    // TUIs with an unsubmitted line.
    //
    // A false here means the text was NOT delivered whole - the pane has no
    // live process, or the input queue for a pane still starting up could not
    // take all of it. Acking either as success is what let `aya pane send` exit
    // 0 having typed nothing (or half of something), and `pane list` enumerates
    // panes from the on-disk config, so a stale name is easy to reach.
    //
    // The message stays about the OUTCOME rather than naming a cause, because
    // the sink deliberately does not distinguish them: a partially-queued write
    // leaves its head in the pane, so "not delivered" is the honest claim and
    // "no running process" would be a guess that is sometimes wrong.
    if ((await writePane(terminalId, request.text)) === false) {
      throw new Error(
        `pane "${name}" did not accept the text - it may have exited, or be starting up with a full input queue. Nothing was submitted; check the pane before retrying.`,
      );
    }
    if (request.submit) {
      await new Promise((resolve) =>
        setTimeout(resolve, PANE_SEND_SUBMIT_DELAY_MS),
      );
      // The pane can die during the gap; report it rather than claim a submit
      // that never happened.
      if ((await writePane(terminalId, "\r")) === false) {
        throw new Error(`pane "${name}" exited before the text was submitted`);
      }
    }
    return { terminalId, projectSlug, name };
  });
}

/** One in-flight pane-send per terminal, chained so each completes its whole
 *  text+gap+Enter sequence before the next begins. Entries are dropped as soon
 *  as the chain drains, so the map does not grow with pane count. */
const paneLocks = new Map<string, Promise<unknown>>();

async function withPaneLock<T>(
  terminalId: string,
  run: () => Promise<T>,
): Promise<T> {
  const prior = paneLocks.get(terminalId) ?? Promise.resolve();
  // We wait for the predecessor to finish but deliberately ignore HOW it
  // finished: one send that fails must not cancel the sends queued behind it.
  const mine = prior.catch(() => {}).then(run);
  paneLocks.set(terminalId, mine);
  try {
    return await mine;
  } finally {
    // Only the last sender in the chain clears the slot - anyone queued behind
    // us has already replaced it with their own.
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

  // allowHalfOpen, because a pane-send holds the connection open across the
  // submit gap: a client using the textbook `socket.end(frame)` shape sends its
  // FIN immediately, and without this the incoming FIN auto-ends our writable
  // side and the reply 150 ms later is dropped - turning "fail loudly" back
  // into a silent success for that client. We always end the socket ourselves.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = "";
    // One request per connection. Without this, `buffer` still holds the
    // dispatched line, so any further byte on the socket re-runs the SAME
    // request - and since pane-send now stays open across the submit gap,
    // that window is 150 ms wide rather than a microtask.
    let handled = false;
    // Our answer has been written and our FIN sent; nothing more is owed.
    let replied = false;
    socket.setEncoding("utf8");
    // A peer that vanishes mid-reply, or a write onto an ended stream, emits
    // "error" on the socket. With no listener that is an uncaught exception in
    // the Electron MAIN process, which takes down more than the request.
    socket.on("error", () => {
      handled = true;
    });
    // allowHalfOpen means Node will NOT end our side when the peer's FIN
    // arrives, so a connection that dies before its frame is complete would
    // otherwise be retained for the life of the main process. Grant the
    // half-open window only to a request we are actually answering.
    socket.on("end", () => {
      // Peer finished sending. Destroy unless we still owe it a reply - that
      // delayed-reply window is the whole reason allowHalfOpen is on.
      if (!handled || replied) socket.destroy();
    });
    // Same for a peer that connects and then says nothing at all. The guard is
    // `!handled`, so a pane-send - which is idle on the wire for the whole
    // submit gap but has already been dispatched - is never reaped.
    socket.setTimeout(options.idleTimeoutMs ?? CONTROL_CONNECTION_IDLE_MS, () => {
      if (!handled) socket.destroy();
    });
    /** Finish the exchange. `end()` alone is not enough under allowHalfOpen:
     *  Node leaves the socket alive waiting on the peer and the idle timer above
     *  stays armed, so every completed request would leak a socket and a timer
     *  in the main process. But destroying immediately is too brutal - a client
     *  still pushing the tail of an oversized frame would get EPIPE instead of
     *  reading our "request too large" answer. So: send the reply and our FIN,
     *  then let the peer drain and close (the "end" handler above), with a short
     *  linger as the backstop for a peer that never finishes. */
    const finish = (): void => {
      replied = true;
      socket.end();
      socket.setTimeout(CONTROL_LINGER_MS, () => socket.destroy());
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > CONTROL_REQUEST_MAX_SIZE_BYTES) {
        // handled FIRST: an oversized frame arrives in several reads, and
        // without this every later chunk re-enters here and writes onto the
        // socket we just ended (ERR_STREAM_WRITE_AFTER_END). `aya pane send`
        // with ~70 KB of text is enough to reach it.
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
