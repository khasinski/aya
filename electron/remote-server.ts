import { app } from "electron";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectConfig } from "./types";
import { REMOTE_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import {
  REMOTE_PROTOCOL_VERSION,
  remoteError,
  remoteHello,
  remoteSnapshot,
  type RemoteHostInfo,
  type RemoteSnapshot,
} from "./remote-protocol";

export interface RemoteServerOptions {
  appVersion: string;
  getSnapshot: () => Promise<RemoteSnapshot>;
  createProject: (name: string, directory: string) => Promise<ProjectConfig>;
  host?: RemoteHostInfo;
}

function sendJson(socket: net.Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
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
): Promise<void> {
  if (!isRecord(raw)) {
    sendJson(socket, remoteError("bad_request", "Remote command must be an object."));
    return;
  }
  const id = optionalString(raw.id);
  const type = optionalString(raw.type);
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
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          void handleCommand(socket, options, JSON.parse(line));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(socket, remoteError("bad_json", message));
        }
      }
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

export function startRemoteServer(options: RemoteServerOptions): () => void {
  const stop = startRemoteServerOn(REMOTE_SOCKET_PATH, options);
  app.once("before-quit", stop);
  return stop;
}
