import { app } from "electron";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { REMOTE_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import {
  remoteError,
  remoteHello,
  remoteSnapshot,
  type RemoteHostInfo,
  type RemoteSnapshot,
} from "./remote-protocol";

export interface RemoteServerOptions {
  appVersion: string;
  getSnapshot: () => Promise<RemoteSnapshot>;
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

function unsupportedCommand(socket: net.Socket): void {
  sendJson(
    socket,
    remoteError(
      "read_only",
      "Aya remote is currently read-only; control commands are not available yet.",
    ),
  );
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
        unsupportedCommand(socket);
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
