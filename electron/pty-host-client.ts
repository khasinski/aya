import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { WebContents } from "electron";
import { PTY_HOST_SOCKET_PATH } from "./paths";
import {
  asSearchResult,
  type PtyHostMessage,
  type PtyHostRequest,
  type PtyHostResponse,
} from "./pty-host-protocol";
import type { BufferSearchHit } from "./pty";
import type { SpawnRequest } from "./types";

// Deadline waiting for the pty host to create its socket (ms).
const PTY_HOST_SOCKET_WAIT_TIMEOUT_MS = 5_000;
// Interval between socket-existence polls while waiting (ms).
const PTY_HOST_SOCKET_POLL_INTERVAL_MS = 50;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class PtyHostClient {
  private socket: net.Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private webContents: WebContents | null = null;

  constructor(private readonly hostScript: string) {}

  setWebContents(webContents: WebContents): void {
    this.webContents = webContents;
  }

  async spawn(req: SpawnRequest): Promise<void> {
    await this.request({ id: 0, type: "spawn", req });
  }

  async write(ptyId: string, data: string): Promise<void> {
    await this.request({ id: 0, type: "write", ptyId, data });
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    await this.request({ id: 0, type: "resize", ptyId, cols, rows });
  }

  async kill(ptyId: string): Promise<void> {
    await this.request({ id: 0, type: "kill", ptyId });
  }

  async shutdown(): Promise<void> {
    await this.request({ id: 0, type: "shutdown" });
    this.socket?.destroy();
    this.socket = null;
  }

  async search(query: string): Promise<BufferSearchHit[]> {
    return asSearchResult(await this.request({ id: 0, type: "search", query }));
  }

  private async request(request: PtyHostRequest): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("PTY host is not connected");
    const id = this.nextId++;
    const withId = { ...request, id } as PtyHostRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify(withId)}\n`, (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithHostStart().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectWithHostStart(): Promise<void> {
    try {
      await this.openSocket();
      return;
    } catch {
      this.startHost();
      await this.waitForSocket();
      await this.openSocket();
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(PTY_HOST_SOCKET_PATH);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        this.buffer = "";
        socket.on("data", (chunk) => this.onData(String(chunk)));
        socket.on("close", () => this.onClose());
        socket.on("error", () => {
          // close handles pending rejection
        });
        resolve();
      });
      socket.once("error", reject);
    });
  }

  private startHost(): void {
    try {
      fs.rmSync(PTY_HOST_SOCKET_PATH, { force: true });
    } catch {
      // best effort
    }
    const child = spawn(process.execPath, [this.hostScript], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    child.unref();
  }

  private async waitForSocket(): Promise<void> {
    const deadline = Date.now() + PTY_HOST_SOCKET_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(PTY_HOST_SOCKET_PATH)) return;
      await new Promise((resolve) => setTimeout(resolve, PTY_HOST_SOCKET_POLL_INTERVAL_MS));
    }
    throw new Error(`PTY host did not create ${path.basename(PTY_HOST_SOCKET_PATH)}`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const idx = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line) as PtyHostMessage;
      if ("type" in message && message.type === "event") {
        if (this.webContents && !this.webContents.isDestroyed()) {
          this.webContents.send("pty:event", message.event);
        }
        continue;
      }
      if ("id" in message) this.onResponse(message);
    }
  }

  private onResponse(message: PtyHostResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  private onClose(): void {
    this.socket = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("PTY host disconnected"));
    }
    this.pending.clear();
  }
}
