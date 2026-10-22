import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectConfig } from "./types";
import { listenOwnerOnly } from "./owner-socket";
import { printable } from "./printable";
import { REMOTE_SOCKET_PATH } from "./paths";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_MAX_FRAME_BYTES,
  remoteError,
  remoteHello,
  remoteSnapshot,
  parseRemoteTerminalRequest,
  REMOTE_TERMINAL_PROTOCOL_VERSION,
  type RemoteHostInfo,
  type RemoteSnapshot,
} from "./remote-protocol";
import type { RemotePtySessions } from "./remote-pty-sessions";
import { writeRemoteTerminalFrame } from "./remote-terminal-stream";

export interface RemoteServerOptions {
  appVersion: string;
  getSnapshot: () => Promise<RemoteSnapshot>;
  createProject: (name: string, directory: string) => Promise<ProjectConfig>;
  host?: RemoteHostInfo;
  terminalSessions?: RemotePtySessions;
}

// The stream is JSON for the other Aya, but `aya remote --stdio` run by hand prints it to a terminal: printable keeps
// the JSON and its data and leaves nothing there to act on, as on the control socket (control.ts printableReply).
function sendJson(socket: net.Socket, value: unknown): void {
  const frame = `${printable(JSON.stringify(value))}\n`;
  if (Buffer.byteLength(frame, "utf8") > REMOTE_MAX_FRAME_BYTES) {
    socket.end(`${JSON.stringify(remoteError("frame_too_large", "Remote response exceeded the frame size limit."))}\n`);
    return;
  }
  socket.write(frame);
}

// Terminal output includes ANSI control sequences by design. JSON.stringify
// safely frames those bytes; applying printable here would corrupt PTY data.
function sendTerminalJson(socket: net.Socket, value: unknown): void {
  writeRemoteTerminalFrame(socket, value);
}

function defaultHostInfo(): RemoteHostInfo {
  return {
    id: os.hostname(),
    name: os.hostname(),
    platform: process.platform,
    user: os.userInfo().username,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function listDirectories(rawPath: string | undefined) {
  const base = rawPath ? expandRemotePath(rawPath) : os.homedir();
  const entries = await fs.promises.readdir(base, { withFileTypes: true });
  return {
    path: base,
    entries: entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        path: path.join(base, entry.name),
        kind: "directory" as const,
      })),
  };
}

function expandRemotePath(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
  return path.resolve(rawPath);
}

async function handleCommand(
  socket: net.Socket,
  options: RemoteServerOptions,
  raw: unknown,
  terminalSession: { protocol: number | null },
): Promise<void> {
  if (!isRecord(raw)) {
    sendJson(socket, remoteError("bad_request", "Remote command must be an object."));
    return;
  }
  const id = optionalString(raw.id);
  const type = optionalString(raw.type);
  if (type === "session:open") {
    const request = parseRemoteTerminalRequest(raw);
    if (!request || request.type !== "session:open") {
      sendTerminalJson(socket, remoteError("bad_request", "Remote terminal session request is invalid."));
      return;
    }
    const requested = request.protocol;
    if (!Number.isSafeInteger(requested) || requested !== REMOTE_TERMINAL_PROTOCOL_VERSION) {
      sendTerminalJson(socket, remoteError("protocol_mismatch", `Remote terminal protocol ${String(requested)} is not supported; use version ${REMOTE_TERMINAL_PROTOCOL_VERSION}.`, id));
      return;
    }
    if (!options.terminalSessions) {
      sendTerminalJson(socket, remoteError("terminal_unavailable", "Remote terminals are not available on this Aya.", id));
      return;
    }
    terminalSession.protocol = REMOTE_TERMINAL_PROTOCOL_VERSION;
    sendTerminalJson(socket, { type: "session:ready", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id: request.id });
    return;
  }
  if (typeof type === "string" && type.startsWith("pty:") && (terminalSession.protocol !== null || raw.protocol === REMOTE_TERMINAL_PROTOCOL_VERSION)) {
    if (terminalSession.protocol !== REMOTE_TERMINAL_PROTOCOL_VERSION) {
      sendTerminalJson(socket, remoteError("protocol_required", "Open a supported remote terminal session before using terminal commands.", id));
      return;
    }
    if (raw.protocol !== REMOTE_TERMINAL_PROTOCOL_VERSION) {
      sendTerminalJson(socket, remoteError("protocol_mismatch", `Remote terminal protocol ${String(raw.protocol)} is not supported; use version ${REMOTE_TERMINAL_PROTOCOL_VERSION}.`, id));
      return;
    }
    await options.terminalSessions!.handle(socket, raw, sendTerminalJson);
    return;
  }
  try {
    if (type === "fs:list") {
      const result = await listDirectories(optionalString(raw.path));
      sendJson(socket, {
        type: "fs:list-result",
        protocol: REMOTE_PROTOCOL_VERSION,
        id: id ?? "",
        ...result,
      });
      return;
    }
    if (type === "fs:mkdir") {
      const directory = optionalString(raw.path);
      if (!directory) throw new Error("fs:mkdir.path is required");
      const expanded = expandRemotePath(directory);
      await fs.promises.mkdir(expanded, { recursive: true });
      sendJson(socket, {
        type: "fs:mkdir-result",
        protocol: REMOTE_PROTOCOL_VERSION,
        id: id ?? "",
        path: expanded,
      });
      return;
    }
    if (type === "project:create") {
      const directory = optionalString(raw.directory);
      if (!directory) throw new Error("project:create.directory is required");
      const name = optionalString(raw.name) ?? path.basename(directory);
      const project = await options.createProject(name, expandRemotePath(directory));
      sendJson(socket, {
        type: "project:create-result",
        protocol: REMOTE_PROTOCOL_VERSION,
        id: id ?? "",
        project,
      });
      return;
    }
    sendJson(
      socket,
      remoteError(
        "read_only",
        "Aya remote command is not available yet.",
        id,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(socket, remoteError("command_failed", message, id));
  }
}

export function startRemoteServerOn(
  socketPath: string,
  options: RemoteServerOptions,
): () => void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // best effort
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    const terminalSession = { protocol: null as number | null };
    sendJson(
      socket,
      remoteHello(options.host ?? defaultHostInfo(), options.appVersion),
    );
    void options
      .getSnapshot()
      .then((snapshot) => sendJson(socket, remoteSnapshot(snapshot)))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(socket, remoteError("snapshot_failed", message));
        socket.end();
      });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) {
          if (Buffer.byteLength(buffer, "utf8") > REMOTE_MAX_FRAME_BYTES) {
            sendJson(socket, remoteError("frame_too_large", "Remote request exceeded the frame size limit."));
            socket.end();
          }
          return;
        }
        if (Buffer.byteLength(buffer.slice(0, idx), "utf8") > REMOTE_MAX_FRAME_BYTES) {
          sendJson(socket, remoteError("frame_too_large", "Remote request exceeded the frame size limit."));
          socket.end();
          return;
        }
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          void handleCommand(socket, options, JSON.parse(line), terminalSession);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(socket, remoteError("bad_json", message));
        }
      }
    });
    socket.on("end", () => socket.end());
    socket.on("close", () => options.terminalSessions?.detach(socket));
  });

  listenOwnerOnly(server, socketPath);

  return () => {
    server.close();
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // best effort
    }
  };
}

export function startRemoteServer(options: RemoteServerOptions): () => void {
  // startRemoteServerOn is intentionally usable from plain Node. Load the
  // Electron lifecycle only in the packaged-app wrapper.
  const { app } = require("electron") as typeof import("electron");
  const stop = startRemoteServerOn(REMOTE_SOCKET_PATH, options);
  app.once("before-quit", stop);
  return stop;
}
