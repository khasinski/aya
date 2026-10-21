import * as net from "node:net";
import { randomUUID } from "node:crypto";
import type { PtyEvent, ProjectConfig } from "./types";
import type { Preset } from "./presets";
import type { PtyEventSink } from "./pty-host-client";
import { MAX_PTY_PANES } from "./pty-pane-limits";
import { REMOTE_TERMINAL_FRAME_DATA_MAX_BYTES, writeRemoteTerminalFrame } from "./remote-terminal-stream";
import {
  parseRemoteTerminalRequest,
  REMOTE_TERMINAL_PROTOCOL_VERSION,
  REMOTE_TERMINAL_REPLAY_MAX_BYTES,
  type RemoteTerminalMessage,
} from "./remote-protocol";

export interface RemoteTerminalSessionDeps {
  listProjects: () => Promise<ProjectConfig[]>;
  listPresets: () => Promise<Preset[]>;
  ensureCapacity?: () => Promise<void>;
  spawn: (terminalId: string, project: ProjectConfig, preset: Preset, cols: number, rows: number) => Promise<RemoteTerminalProcessIdentity | void>;
  onSpawned?: (terminalId: string, project: ProjectConfig, preset: Preset) => Promise<void>;
  write: (terminalId: string, data: string) => Promise<boolean>;
  resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  exit: (terminalId: string) => Promise<void>;
  isRunning?: (identity: RemoteTerminalProcessIdentity | undefined) => Promise<boolean | null>;
  newId?: () => string;
}

export interface RemoteTerminalProcessIdentity {
  pid: number;
  startIdentity: string;
}

const REPLAY_BLOCK_BYTES = 64 * 1024;
interface OutputChunk { offset: number; bytes: Buffer; start: number; end: number }
interface Session {
  terminalId: string;
  project: string;
  preset: string;
  state: "running" | "exited" | "failed" | "uncertain";
  exitCode?: number;
  failureReason?: string;
  spawnFailed?: boolean;
  processIdentity?: RemoteTerminalProcessIdentity;
  totalBytes: number;
  retainedBytes: number;
  chunks: OutputChunk[];
  clients: Set<net.Socket>;
}

export type RemoteTerminalWriter = (socket: net.Socket, message: unknown) => void;

/** Per-main-process remote terminal registry. It owns only stream attachments
 * and a bounded replay ring; PTY ownership remains in the ordinary terminal
 * host behind the injected callbacks. */
export class RemotePtySessions implements PtyEventSink {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: RemoteTerminalSessionDeps) {}

  isDestroyed(): boolean { return false; }
  send(_channel: "pty:event", event: PtyEvent): void { this.onPtyEvent(event); }

  detach(socket: net.Socket): void {
    for (const session of this.sessions.values()) session.clients.delete(socket);
  }

  onPtyEvent(event: PtyEvent): void {
    const session = this.sessions.get(event.ptyId);
    if (!session) return;
    if (event.type === "data") {
      // PtyHostClient replays existing output to every sink when a local
      // window remounts. It is not new stream data and must not advance the
      // remote offset a second time.
      if (event.replay) return;
      const bytes = Buffer.from(event.chunk, "utf8");
      if (bytes.length === 0) return;
      const offset = session.totalBytes;
      session.totalBytes += bytes.length;
      this.appendReplay(session, offset, bytes);
      for (const socket of [...session.clients]) this.writeOutput(socket, event.ptyId, offset, bytes);
      return;
    }
    if (event.type === "exit") {
      // pty-core reports a failed spawn before its banner and synthetic exit.
      // Keep that classification through the whole event sequence so the
      // original failure is returned to the caller that has not attached yet.
      if (session.spawnFailed || session.state === "exited") return;
      session.state = "exited";
      session.exitCode = event.exitCode;
      const message: RemoteTerminalMessage = {
        type: "pty:exited", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION,
        terminalId: event.ptyId, exitCode: session.exitCode,
      };
      for (const socket of [...session.clients]) this.write(socket, message);
      return;
    }
    if (event.type === "spawn-failed" || event.type === "no-session") {
      session.state = "failed";
      session.spawnFailed = true;
      session.failureReason = event.type === "spawn-failed" ? event.detail : "The host no longer has this terminal.";
      const message: RemoteTerminalMessage = {
        type: "pty:spawn-failed", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION,
        terminalId: event.ptyId,
        ...(event.type === "spawn-failed" ? { reason: event.reason } : {}),
        message: session.failureReason,
      };
      for (const socket of [...session.clients]) this.write(socket, message);
    }
  }

  async handle(socket: net.Socket, raw: unknown, writer: RemoteTerminalWriter): Promise<void> {
    const request = parseRemoteTerminalRequest(raw);
    if (!request || request.type === "session:open") {
      const requestId = isRecord(raw) && typeof raw.id === "string" && raw.id.length <= 128 ? raw.id : undefined;
      writer(socket, { type: "error", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, ...(requestId ? { id: requestId } : {}), code: "bad_request", message: "Remote terminal request is invalid." });
      return;
    }
    const id = request.id;
    try {
      switch (request.type) {
        case "pty:spawn": {
          await this.deps.ensureCapacity?.();
          const projects = await this.deps.listProjects();
          const project = projects.find((item) => item.slug === request.project && !item.remote);
          if (!project) throw new Error("The selected host project is unavailable.");
          const preset = (await this.deps.listPresets()).find((item) => item.id === request.preset);
          if (!preset || !preset.command.trim()) throw new Error("The selected terminal preset is unavailable.");
          this.makeRoom();
          const terminalId = (this.deps.newId ?? randomUUID)();
          const session: Session = { terminalId, project: project.slug, preset: preset.id, state: "running", totalBytes: 0, retainedBytes: 0, chunks: [], clients: new Set() };
          this.sessions.set(terminalId, session);
          try {
            const processIdentity = await this.deps.spawn(terminalId, project, preset, request.cols, request.rows);
            if (processIdentity) session.processIdentity = processIdentity;
            if (session.state === "failed") throw new Error(session.failureReason ?? "The remote terminal could not be started.");
            await this.deps.onSpawned?.(terminalId, project, preset);
          } catch (error) {
            session.state = "failed";
            session.failureReason ??= error instanceof Error ? error.message : "The remote terminal could not be started.";
            throw error;
          }
          writer(socket, { type: "pty:spawned", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id, terminalId, project: project.slug, preset: preset.id });
          return;
        }
        case "pty:attach": {
          const session = this.sessions.get(request.terminalId);
          if (!session) throw new Error("The remote terminal is no longer available.");
          if (session.state === "failed") throw new Error(session.failureReason ?? "The remote terminal could not be started.");
          if (request.offset > session.totalBytes) throw new Error("The requested output position is ahead of this terminal.");
          const oldest = session.chunks[0] ? session.chunks[0].offset + session.chunks[0].start : session.totalBytes;
          let fromOffset = Math.max(request.offset, oldest);
          let replay = this.readFrom(session, fromOffset);
          while (replay.length && (replay[0] & 0xc0) === 0x80) {
            replay = replay.subarray(1);
            fromOffset += 1;
          }
          session.clients.add(socket);
          writer(socket, {
            type: "pty:attached", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id,
            terminalId: session.terminalId, fromOffset, endOffset: session.totalBytes,
            truncated: request.offset < oldest,
          });
          if (replay.length) this.writeOutput(socket, session.terminalId, fromOffset, replay, writer);
          if (session.state === "exited") writer(socket, { type: "pty:exited", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, terminalId: session.terminalId, exitCode: session.exitCode ?? 0 });
          return;
        }
        case "pty:write": {
          if (this.sessions.get(request.terminalId)?.state !== "running") throw new Error("The remote terminal is no longer running.");
          const accepted = await this.deps.write(request.terminalId, request.data);
          writer(socket, { type: "pty:written", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id, terminalId: request.terminalId, accepted });
          return;
        }
        case "pty:resize": {
          if (this.sessions.get(request.terminalId)?.state !== "running") throw new Error("The remote terminal is no longer running.");
          await this.deps.resize(request.terminalId, request.cols, request.rows);
          writer(socket, { type: "pty:resized", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id, terminalId: request.terminalId });
          return;
        }
        case "pty:exit": {
          const session = this.sessions.get(request.terminalId);
          if (!session) throw new Error("The remote terminal is no longer available.");
          if (session.state === "running" || session.state === "uncertain" || (session.state === "failed" && !session.spawnFailed)) {
            try {
              await this.deps.exit(request.terminalId);
            } catch (error) {
              const running = await this.deps.isRunning?.(session.processIdentity).catch(() => null);
              if (running !== false) {
                session.state = "uncertain";
                session.failureReason = "Aya could not confirm that this terminal stopped. It may still be running.";
                throw new Error(session.failureReason, { cause: error });
              }
              session.state = "exited";
              session.exitCode = 0;
              this.sendExit(session);
              writer(socket, { type: "pty:exit-result", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id, terminalId: request.terminalId });
              return;
            }
          }
          if (session.state !== "exited" && !session.spawnFailed) {
            session.state = "exited";
            session.exitCode = 0;
            this.sendExit(session);
          }
          writer(socket, { type: "pty:exit-result", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id, terminalId: request.terminalId });
          return;
        }
        case "pty:list": {
          writer(socket, {
            type: "pty:list-result", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id,
            terminals: [...this.sessions.values()].map(({ terminalId, project, preset, state, totalBytes, failureReason }) => ({ terminalId, project, preset, state, offset: totalBytes, ...(failureReason ? { failureReason } : {}) })),
          });
          return;
        }
      }
    } catch (error) {
      writer(socket, { type: "error", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id, code: "terminal_failed", message: error instanceof Error ? error.message : "Remote terminal request failed." });
    }
  }

  private appendReplay(session: Session, offset: number, input: Buffer): void {
    let bytes = input;
    let firstOffset = offset;
    // Do not retain the backing store of a single oversized event.
    if (bytes.length > REMOTE_TERMINAL_REPLAY_MAX_BYTES) {
      const skipped = bytes.length - REMOTE_TERMINAL_REPLAY_MAX_BYTES;
      bytes = bytes.subarray(skipped);
      firstOffset += skipped;
      session.chunks.length = 0;
      session.retainedBytes = 0;
    }
    let consumed = 0;
    while (consumed < bytes.length) {
      let last = session.chunks[session.chunks.length - 1];
      if (!last || last.end === last.bytes.length) {
        last = { offset: firstOffset + consumed, bytes: Buffer.allocUnsafe(REPLAY_BLOCK_BYTES), start: 0, end: 0 };
        session.chunks.push(last);
      }
      const count = Math.min(bytes.length - consumed, last.bytes.length - last.end);
      bytes.copy(last.bytes, last.end, consumed, consumed + count);
      last.end += count;
      session.retainedBytes += count;
      consumed += count;
    }
    this.trimReplay(session);
  }

  private trimReplay(session: Session): void {
    let excess = session.retainedBytes - REMOTE_TERMINAL_REPLAY_MAX_BYTES;
    while (excess > 0 && session.chunks.length) {
      const first = session.chunks[0];
      const available = first.end - first.start;
      if (available <= excess) {
        excess -= available;
        session.retainedBytes -= available;
        session.chunks.shift();
      } else {
        let cut = excess;
        while (cut < available && (first.bytes[first.start + cut] & 0xc0) === 0x80) cut += 1;
        first.start += cut;
        session.retainedBytes -= cut;
        excess = 0;
      }
    }
    // A block boundary can land inside a UTF-8 sequence after whole blocks
    // are removed. Advance the retained head to the next codepoint boundary.
    const first = session.chunks[0];
    if (first) {
      while (first.start < first.end && (first.bytes[first.start] & 0xc0) === 0x80) {
        first.start += 1;
        session.retainedBytes -= 1;
      }
      if (first.start === first.end) session.chunks.shift();
    }
  }

  private makeRoom(): void {
    while (this.sessions.size >= MAX_PTY_PANES) {
      const disposable = [...this.sessions.values()].find((session) => session.state === "exited" || (session.state === "failed" && session.spawnFailed));
      if (!disposable) throw new Error("The host already has the maximum number of remote terminals.");
      this.sessions.delete(disposable.terminalId);
    }
  }

  private readFrom(session: Session, offset: number): Buffer {
    return Buffer.concat(session.chunks.flatMap((item) => {
      const startOffset = item.offset + item.start;
      const endOffset = item.offset + item.end;
      if (endOffset <= offset) return [];
      const start = Math.max(item.start, item.start + offset - startOffset);
      return [item.bytes.subarray(start, item.end)];
    }));
  }

  private sendExit(session: Session): void {
    const ended: RemoteTerminalMessage = { type: "pty:exited", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, terminalId: session.terminalId, exitCode: session.exitCode ?? 0 };
    for (const client of [...session.clients]) this.write(client, ended);
  }

  private writeOutput(socket: net.Socket, terminalId: string, offset: number, bytes: Buffer, writer: RemoteTerminalWriter = (target, message) => this.write(target, message)): void {
    let cursor = 0;
    while (cursor < bytes.length && !socket.destroyed) {
      let end = Math.min(bytes.length, cursor + REMOTE_TERMINAL_FRAME_DATA_MAX_BYTES);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
      if (end === cursor) end = Math.min(bytes.length, cursor + REMOTE_TERMINAL_FRAME_DATA_MAX_BYTES);
      writer(socket, {
        type: "pty:output", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION,
        terminalId, offset: offset + cursor, data: bytes.subarray(cursor, end).toString("utf8"),
      });
      cursor = end;
    }
  }

  private write(socket: net.Socket, message: unknown): void {
    writeRemoteTerminalFrame(socket, message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
