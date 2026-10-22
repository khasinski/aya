import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  Preset,
  ProjectConfig,
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
  RemoteHealthResult,
  RemoteHostInfo,
  RemoteProjectCreateResult,
} from "./types";
import { AYA_HOME_DIRNAME, REMOTE_SOCKET_NAME } from "./paths";
import { REMOTE_MAX_FRAME_BYTES, REMOTE_PROTOCOL_VERSION, REMOTE_TERMINAL_PROTOCOL_VERSION, type RemoteMessage } from "./remote-protocol";
import { shellQuote } from "./pane-command";
import { socketPathLimit } from "./socket-path";
import { isSshTarget, requireSshTarget, sshArgs } from "./ssh";

export interface RemoteTimeouts {
  bridgeMs: number;
  sshKillMs: number;
}
// The bridge's timer starts only once ssh has connected and node is up, so the kill
// waits 10s longer; an ssh setup slower than that is reported as ssh, which it is.
export const REMOTE_TIMEOUTS: RemoteTimeouts = { bridgeMs: 15_000, sshKillMs: 25_000 };
// Cap on the base64 bridge child's stdout - bounds the remote snapshot size.
const REMOTE_BRIDGE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
// The bridge's grace after client.end() for stdout to flush before it exits.
const EXIT_FLUSH_DELAY_MS = 250;

export interface RemoteTerminalAttachResult {
  terminalId: string;
  fromOffset: number;
  endOffset: number;
  truncated: boolean;
}

interface PendingTerminalRequest {
  expected: string[];
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/** Multiplexes v2 terminal requests over the existing line-framed
 * aya remote --stdio bridge. The underlying bridge can be ssh, a local test
 * child, or another Duplex-compatible process. */
export class RemoteTerminalClient extends EventEmitter {
  private readonly pending = new Map<string, PendingTerminalRequest>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private nextId = 1;
  private buffer = "";
  private deferOutputEvents = false;
  private deferredOutputEvents: Array<{ terminalId: string; offset: number; data: string }> = [];
  private deferredExitEvents: Array<{ terminalId: string; exitCode?: number; killed?: true }> = [];
  private outputFlushScheduled = false;
  private snapshotReceived = false;
  private opened = false;
  private closed = false;

  constructor(private readonly bridge: ChildProcess) {
    super();
    if (!bridge.stdin || !bridge.stdout) throw new Error("Remote terminal bridge needs piped stdin and stdout.");
    bridge.stdout.setEncoding("utf8");
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    bridge.stdout.on("data", (chunk: string) => this.onData(chunk));
    bridge.once("error", (error) => this.fail(error));
    bridge.once("close", (code, signal) => this.fail(new Error(`Remote terminal bridge closed (${signal ?? code ?? "unknown"}).`)));
  }

  static open(sshTarget: string): RemoteTerminalClient {
    const target = requireSshTarget(sshTarget);
    const bridge = spawn("ssh", sshArgs(target, ["aya remote --stdio"]), { stdio: ["pipe", "pipe", "pipe"] });
    return new RemoteTerminalClient(bridge);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) {
        if (Buffer.byteLength(this.buffer, "utf8") > REMOTE_MAX_FRAME_BYTES) {
          this.fail(new Error("Remote terminal bridge sent a frame over the 2 MiB limit."));
          this.bridge.kill();
        }
        return;
      }
      if (Buffer.byteLength(this.buffer.slice(0, idx), "utf8") > REMOTE_MAX_FRAME_BYTES) {
        this.fail(new Error("Remote terminal bridge sent a frame over the 2 MiB limit."));
        this.bridge.kill();
        return;
      }
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { this.fail(new Error("Remote Aya returned invalid JSON.")); continue; }
      if (!isRecord(value)) { this.fail(new Error("Remote Aya returned an invalid message.")); continue; }
      this.onMessage(value);
    }
  }

  private onMessage(value: Record<string, unknown>): void {
    if (value.type === "hello") {
      if (value.protocol !== REMOTE_PROTOCOL_VERSION) {
        this.fail(new Error(`Remote Aya uses protocol ${String(value.protocol)}; this client supports ${REMOTE_PROTOCOL_VERSION}.`));
        return;
      }
      return;
    }
    if (value.type === "snapshot") {
      if (value.protocol !== REMOTE_PROTOCOL_VERSION) { this.fail(new Error("Remote Aya sent an incompatible snapshot.")); return; }
      if (!this.snapshotReceived) {
        this.snapshotReceived = true;
        this.send({ type: "session:open", protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id: this.id() });
      }
      return;
    }
    if (value.type === "error") {
      const id = typeof value.id === "string" ? value.id : "";
      if (id && this.pending.has(id)) this.rejectPending(id, new Error(typeof value.message === "string" ? value.message : "Remote Aya rejected the request."));
      else if (!this.opened) {
        const message = value.code === "read_only"
          ? "Remote Aya does not support terminal protocol version 2; update Aya on the host."
          : typeof value.message === "string" ? value.message : "Remote Aya rejected the terminal session.";
        this.fail(new Error(message));
      }
      return;
    }
    if (value.type === "session:ready") {
      if (value.protocol !== REMOTE_TERMINAL_PROTOCOL_VERSION) { this.fail(new Error("Remote Aya did not accept terminal protocol version 2.")); return; }
      this.opened = true;
      this.readyResolve();
      return;
    }
    if (value.type === "pty:output") {
      if (value.protocol === REMOTE_TERMINAL_PROTOCOL_VERSION && typeof value.terminalId === "string" && Number.isSafeInteger(value.offset) && typeof value.data === "string") {
        const output = { terminalId: value.terminalId, offset: value.offset as number, data: value.data };
        if (this.deferOutputEvents) this.deferredOutputEvents.push(output);
        else this.emit("output", output);
      }
      return;
    }
    if (value.type === "pty:exited") {
      const hasExitCode = Number.isInteger(value.exitCode);
      const wasKilled = value.killed === true;
      if (value.protocol === REMOTE_TERMINAL_PROTOCOL_VERSION && typeof value.terminalId === "string" && hasExitCode !== wasKilled) {
        const exit = wasKilled ? { terminalId: value.terminalId, killed: true as const } : { terminalId: value.terminalId, exitCode: value.exitCode as number };
        if (this.deferOutputEvents) this.deferredExitEvents.push(exit);
        else this.emit("exit", exit);
      }
      return;
    }
    if (value.type === "pty:spawn-failed") {
      if (value.protocol === REMOTE_TERMINAL_PROTOCOL_VERSION && typeof value.terminalId === "string" && typeof value.message === "string") {
        this.emit("spawn-failed", { terminalId: value.terminalId, reason: typeof value.reason === "string" ? value.reason : undefined, message: value.message });
      }
      return;
    }
    const id = typeof value.id === "string" ? value.id : "";
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      if (pending.expected.includes(String(value.type))) {
        this.pending.delete(id);
        if (value.type === "pty:attached") this.deferOutputForAwaitContinuation();
        pending.resolve(value);
      }
    }
  }

  async spawnTerminal(project: string, preset: string, cols: number, rows: number): Promise<{ terminalId: string }> {
    const response = await this.request("pty:spawn", ["pty:spawned"], { project, preset, cols, rows });
    if (typeof response.terminalId !== "string") throw new Error("Remote Aya returned an invalid terminal id.");
    return { terminalId: response.terminalId };
  }

  async attach(terminalId: string, offset: number): Promise<RemoteTerminalAttachResult> {
    const response = await this.request("pty:attach", ["pty:attached"], { terminalId, offset });
    if (typeof response.terminalId !== "string" || !Number.isSafeInteger(response.fromOffset) || !Number.isSafeInteger(response.endOffset) || typeof response.truncated !== "boolean") throw new Error("Remote Aya returned an invalid attach response.");
    return { terminalId: response.terminalId, fromOffset: response.fromOffset as number, endOffset: response.endOffset as number, truncated: response.truncated };
  }

  async write(terminalId: string, data: string): Promise<boolean> {
    const response = await this.request("pty:write", ["pty:written"], { terminalId, data });
    if (typeof response.accepted !== "boolean") throw new Error("Remote Aya returned an invalid write response.");
    return response.accepted;
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    await this.request("pty:resize", ["pty:resized"], { terminalId, cols, rows });
  }

  async exit(terminalId: string): Promise<void> {
    await this.request("pty:exit", ["pty:exit-result"], { terminalId });
  }

  async list(): Promise<Array<{ terminalId: string; project: string; preset: string; state: "running" | "exited" | "failed" | "uncertain"; offset: number; failureReason?: string }>> {
    const response = await this.request("pty:list", ["pty:list-result"], {});
    if (!Array.isArray(response.terminals)) throw new Error("Remote Aya returned an invalid terminal list.");
    return response.terminals as Array<{ terminalId: string; project: string; preset: string; state: "running" | "exited" | "failed" | "uncertain"; offset: number; failureReason?: string }>;
  }

  /** Close only the bridge stream. The host does not receive a kill request. */
  detach(): Promise<void> {
    this.closed = true;
    this.pending.forEach((pending) => pending.reject(new Error("Remote terminal bridge detached.")));
    this.pending.clear();
    this.bridge.stdin?.end();
    if (this.bridge.exitCode !== null || this.bridge.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => this.bridge.once("close", () => resolve()));
  }

  private async request(type: string, expected: string[], data: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ready;
    if (this.closed) throw new Error("Remote terminal bridge is closed.");
    const id = this.id();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { expected, resolve, reject });
      this.send({ type, protocol: REMOTE_TERMINAL_PROTOCOL_VERSION, id, ...data });
    });
  }

  private id(): string { return `remote-${this.nextId++}`; }

  private deferOutputForAwaitContinuation(): void {
    this.deferOutputEvents = true;
    if (this.outputFlushScheduled) return;
    this.outputFlushScheduled = true;
    // The attached response and replay may be in the same stdout data event.
    // Let the attach() promise continuation register its output listener first.
    setImmediate(() => {
      this.outputFlushScheduled = false;
      this.deferOutputEvents = false;
      for (const event of this.deferredOutputEvents.splice(0)) this.emit("output", event);
      for (const event of this.deferredExitEvents.splice(0)) this.emit("exit", event);
    });
  }

  private send(value: unknown): void {
    if (!this.bridge.stdin || this.bridge.stdin.destroyed) { this.fail(new Error("Remote terminal bridge is closed.")); return; }
    this.bridge.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(error);
  }

  private fail(error: Error): void {
    if (!this.opened) this.readyReject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.closed && this.listenerCount("error") > 0) this.emit("error", error);
  }
}

function seconds(ms: number): string {
  return `${ms / 1000}s`;
}

export const remoteNodeBridge = (timeoutMs: number): string => `
const net = require("node:net");
const id = process.argv[1];
const payload = Buffer.from(process.argv[2], "base64").toString("utf8");
const socketPath = process.env.AYA_REMOTE_SOCKET ||
  (process.env.AYA_HOME ? process.env.AYA_HOME + "/${REMOTE_SOCKET_NAME}" : process.env.HOME + "/${AYA_HOME_DIRNAME}/${REMOTE_SOCKET_NAME}");
const limit = process.platform === "darwin" ? ${socketPathLimit("darwin")} : ${socketPathLimit("linux")};
const pathBytes = Buffer.byteLength(socketPath);
const client = net.createConnection(socketPath);
let buffer = "";
let settled = false;
let requestSent = false;
function write(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function sendRequest() {
  if (requestSent) return;
  requestSent = true;
  client.write(payload + "\\n");
}
function finish(code) {
  if (settled) return;
  settled = true;
  client.end();
  setTimeout(() => process.exit(code), ${EXIT_FLUSH_DELAY_MS});
}
client.setEncoding("utf8");
client.on("data", (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const idx = buffer.indexOf("\\n");
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message && (message.type === "snapshot" || message.code === "snapshot_failed")) {
      sendRequest();
    }
    if (message && message.id === id) finish(0);
  }
});
client.on("error", (err) => {
  write({
    type: "error",
    protocol: ${REMOTE_PROTOCOL_VERSION},
    id,
    code: "app_unavailable",
    message: pathBytes > limit
      ? "Aya's remote socket path is " + pathBytes + " bytes, the limit is " + limit + ": set a shorter AYA_HOME on the remote host (" + socketPath + ")"
      : "Aya is not accepting remote connections at " + socketPath,
    detail: err.code || err.message,
  });
  finish(1);
});
setTimeout(() => {
  write({
    type: "error",
    protocol: ${REMOTE_PROTOCOL_VERSION},
    id,
    code: "timeout",
    message: "Remote Aya did not respond within ${seconds(timeoutMs)}.",
  });
  finish(1);
}, ${timeoutMs});
`.trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireHost(value: unknown): RemoteHostInfo {
  if (!isRecord(value)) throw new Error("Remote host info is invalid.");
  const { id, name, platform, user } = value;
  if (
    typeof id !== "string" ||
    !id ||
    typeof name !== "string" ||
    !name ||
    typeof platform !== "string" ||
    !platform ||
    typeof user !== "string" ||
    !user
  ) {
    throw new Error("Remote host info is invalid.");
  }
  return {
    id,
    name,
    platform: platform as NodeJS.Platform,
    user,
  };
}

function requireDirectoryEntries(value: unknown): RemoteDirectoryEntry[] {
  if (!Array.isArray(value)) throw new Error("Remote directory list is invalid.");
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.path !== "string" ||
      entry.kind !== "directory"
    ) {
      throw new Error("Remote directory entry is invalid.");
    }
    return { name: entry.name, path: entry.path, kind: "directory" };
  });
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!isRecord(value)) return false;
  return (
    typeof value.slug === "string" &&
    typeof value.name === "string" &&
    typeof value.directory === "string" &&
    Array.isArray(value.tabs)
  );
}

function requireProject(value: unknown): ProjectConfig {
  if (!isProjectConfig(value)) {
    throw new Error("Remote project result is invalid.");
  }
  return value;
}

function requireProjects(value: unknown): ProjectConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isProjectConfig);
}

function requireRecentProjectSlugs(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.recent)) return [];
  return value.recent.filter((slug): slug is string => typeof slug === "string");
}

function orderRecentProjects(
  projects: ProjectConfig[],
  recentSlugs: string[],
): ProjectConfig[] {
  const bySlug = new Map(projects.map((project) => [project.slug, project]));
  const ordered = recentSlugs
    .map((slug) => bySlug.get(slug))
    .filter((project): project is ProjectConfig => !!project);
  return ordered.length > 0 ? ordered : projects;
}

function requirePresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) throw new Error("Remote presets are invalid.");
  return value.filter(
    (preset): preset is Preset =>
      isRecord(preset) &&
      typeof preset.id === "string" &&
      typeof preset.name === "string" &&
      typeof preset.icon === "string" &&
      typeof preset.color === "string" &&
      typeof preset.command === "string",
  );
}

function runRemoteRequest(
  sshTarget: string,
  request: Record<string, unknown>,
  timeouts: RemoteTimeouts = REMOTE_TIMEOUTS,
): Promise<{
  host: RemoteHostInfo;
  presets: Preset[];
  recentProjects: ProjectConfig[];
  response: RemoteMessage;
}> {
  // Never an option: a target such as -oProxyCommand=... would run a local command. The project config checks its
  // own targets, but this is reached from the window too.
  const target = requireSshTarget(sshTarget);
  const id = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({ ...request, id }),
    "utf8",
  ).toString("base64");
  const remoteCommand = `node -e ${shellQuote(remoteNodeBridge(timeouts.bridgeMs))} ${shellQuote(
    id,
  )} ${shellQuote(payload)}`;

  return new Promise((resolve, reject) => {
    let host: RemoteHostInfo | null = null;
    let presets: Preset[] = [];
    let recentProjects: ProjectConfig[] = [];
    // Every remote project in the snapshot (unfiltered, unlike recentProjects
    // which collapses to the recent subset). Lets a caller recover from a
    // command error that still carried a valid snapshot - e.g. an old remote
    // Aya rejecting "project already exists" (see createRemoteProjectOnHost).
    let allProjects: ProjectConfig[] = [];
    execFile(
      "ssh",
      ["--", target, remoteCommand],
      {
        encoding: "utf8",
        timeout: timeouts.sshKillMs,
        maxBuffer: REMOTE_BRIDGE_MAX_BUFFER_BYTES,
      },
      (err, stdout, stderr) => {
        // The remote side's output is untrusted: whatever in it throws (a host that is not a host, a null line, a
        // snapshot without its fields) rejects this request. Uncaught here, it was an exception in the main process
        // and a request that never settled.
        try {
          let matchedError: Error | null = null;
          // An error with no id is about the connection (snapshot_failed): the reason, unless our answer still came.
          let connectionError: Error | null = null;
          for (const line of stdout.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let message: RemoteMessage;
            try {
              message = JSON.parse(trimmed) as RemoteMessage;
            } catch {
              reject(new Error("Remote Aya returned invalid JSON."));
              return;
            }
            if (!isRecord(message)) {
              reject(new Error("Remote Aya returned a message that is not an object."));
              return;
            }
            if (message.type === "hello") {
              host = requireHost(message.host);
              continue;
            }
            if (message.type === "snapshot") {
              if (!isRecord(message.snapshot)) throw new Error("Remote Aya sent a snapshot without its data.");
              presets = requirePresets(message.snapshot.presets);
              allProjects = requireProjects(message.snapshot.projects);
              recentProjects = orderRecentProjects(
                allProjects,
                requireRecentProjectSlugs(message.snapshot.projectState),
              );
              continue;
            }
            if (message.type === "error" && message.id === id) {
              matchedError = new Error(message.message || message.code);
              continue;
            }
            if (message.type === "error" && !("id" in message && message.id)) {
              connectionError ??= new Error(message.message || message.code);
              continue;
            }
            if ("id" in message && message.id === id) {
              if (!host) {
                reject(new Error("Remote Aya response arrived before hello."));
                return;
              }
              resolve({ host, presets, recentProjects, response: message });
              return;
            }
          }
          if (matchedError) {
            // Carry the snapshot context (parsed before the error) so callers can
            // recover from a benign command failure without a second round-trip.
            if (host) {
              (matchedError as RemoteRequestError).remoteContext = {
                host,
                presets,
                projects: allProjects,
              };
            }
            reject(matchedError);
            return;
          }
          if (connectionError) {
            reject(connectionError);
            return;
          }
          const detail = stderr.trim();
          if (
            detail &&
            /node: command not found|command not found: node|node: not found/i.test(
              detail,
            )
          ) {
            reject(
              new Error(
                `Node is not available on ${target}. Install Node or make it available over ssh.`,
              ),
            );
            return;
          }
          if (
            detail &&
            /aya: command not found|command not found: aya|aya: not found/i.test(
              detail,
            )
          ) {
            reject(
              new Error(
                `Aya is not installed on ${target}. Install Aya there and make sure it has been started.`,
              ),
            );
            return;
          }
          if (err?.killed) {
            reject(
              new Error(`ssh ${target} did not finish within ${seconds(timeouts.sshKillMs)}.`),
            );
            return;
          }
          if (err) {
            // Not err.message: it is "Command failed: ssh <target> node -e <the whole bridge>", whose text also sent
            // healthFailureStage to the wrong stage.
            // An exit code: 255 is ssh's own failure, any other the remote bridge's, which then said nothing. No exit
            // code (stdout over maxBuffer, no ssh binary): Node's own message names the cause and not the command.
            const code = (err as { code?: unknown }).code;
            const why =
              typeof code !== "number"
                ? err.message
                : code === 255
                  ? `ssh ${target} failed (exit 255).`
                  : `Remote Aya did not respond on ${target}: its bridge exited ${code} with no output.`;
            reject(new Error(detail || why));
            return;
          }
          reject(new Error(`Remote Aya connection closed before response (0).`));
        } catch (bad) {
          reject(bad instanceof Error ? bad : new Error(String(bad)));
        }
      },
    );
  });
}

export async function listRemoteDirectory(
  sshTarget: string,
  directory?: string,
): Promise<RemoteDirectoryListing> {
  const { host, presets, recentProjects, response } = await runRemoteRequest(sshTarget, {
    type: "fs:list",
    ...(directory ? { path: directory } : {}),
  });
  if (response.type !== "fs:list-result") {
    throw new Error("Remote Aya returned an unexpected response.");
  }
  return {
    host,
    presets,
    recentProjects,
    path: response.path,
    entries: requireDirectoryEntries(response.entries),
  };
}

export async function createRemoteDirectory(
  sshTarget: string,
  directory: string,
): Promise<string> {
  const { response } = await runRemoteRequest(sshTarget, {
    type: "fs:mkdir",
    path: directory,
  });
  if (response.type !== "fs:mkdir-result") {
    throw new Error("Remote Aya returned an unexpected response.");
  }
  return response.path;
}

export async function listRemotePresets(sshTarget: string): Promise<Preset[]> {
  const { presets } = await runRemoteRequest(sshTarget, {
    type: "fs:list",
  });
  return presets;
}

function healthFailureStage(
  message: string,
): "ssh" | "node" | "aya-remote" | "snapshot" {
  if (/node is not available|node: command not found|node: not found/i.test(message)) {
    return "node";
  }
  if (
    /not accepting remote connections|Aya is not installed|app_unavailable|aya-remote|Remote Aya did not respond/i.test(
      message,
    )
  ) {
    return "aya-remote";
  }
  if (/snapshot|presets|projects/i.test(message)) {
    return "snapshot";
  }
  return "ssh";
}

export async function checkRemoteHealth(
  sshTarget: string,
  timeouts: RemoteTimeouts = REMOTE_TIMEOUTS,
): Promise<RemoteHealthResult> {
  const target = sshTarget.trim();
  const checkedAt = new Date().toISOString();
  if (!isSshTarget(target)) {
    const message = target ? `"${target}" is not an ssh target: use a Host alias from ~/.ssh/config or user@host` : "Remote SSH target is required.";
    return { ok: false, sshTarget, checkedAt, checks: [{ stage: "ssh", ok: false, message }] };
  }
  try {
    const { host, presets, recentProjects } = await runRemoteRequest(
      target,
      { type: "fs:list" },
      timeouts,
    );
    return {
      ok: true,
      sshTarget: target,
      checkedAt,
      host,
      presetsCount: presets.length,
      recentProjectsCount: recentProjects.length,
      checks: [
        { stage: "ssh", ok: true, message: `Connected to ${target}.` },
        { stage: "node", ok: true, message: "Remote Node bridge started." },
        { stage: "aya-remote", ok: true, message: "Remote Aya socket responded." },
        { stage: "snapshot", ok: true, message: "Remote presets and projects loaded." },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stage = healthFailureStage(message);
    const order: Array<"ssh" | "node" | "aya-remote" | "snapshot"> = [
      "ssh",
      "node",
      "aya-remote",
      "snapshot",
    ];
    return {
      ok: false,
      sshTarget: target,
      checkedAt,
      checks: order
        .slice(0, order.indexOf(stage) + 1)
        .map((item) =>
          item === stage
            ? { stage: item, ok: false, message }
            : {
                stage: item,
                ok: true,
                message:
                  item === "ssh"
                    ? `Connected to ${target}.`
                    : item === "node"
                      ? "Remote Node bridge started."
                      : "Remote Aya socket responded.",
              },
        ),
    };
  }
}

/** An Error from runRemoteRequest that still carried a usable snapshot (the
 *  request reached the host and got a hello + snapshot before the command
 *  itself failed). */
interface RemoteRequestError extends Error {
  remoteContext?: {
    host: RemoteHostInfo;
    presets: Preset[];
    projects: ProjectConfig[];
  };
}

/** Recover an "open" from a remote "project already exists" rejection. Older
 *  remote Aya builds (before open-or-create) reject re-opening an existing
 *  project instead of returning it. But the project IS there - which is exactly
 *  what opening it needs - and the failed request already carried the host's
 *  full project snapshot. The error names the colliding slug, so we look that
 *  project up and return it as if the create had succeeded. Returns null when
 *  the error is anything else, so the caller rethrows. Exported for tests. */
export function recoverExistingRemoteProject(
  err: unknown,
): RemoteProjectCreateResult | null {
  if (!(err instanceof Error)) return null;
  const ctx = (err as RemoteRequestError).remoteContext;
  if (!ctx) return null;
  const slug = /Project "([^"]+)" already exists/.exec(err.message)?.[1];
  if (!slug) return null;
  const existing = ctx.projects.find((p) => p.slug === slug && !p.remote);
  if (!existing) return null;
  return { host: ctx.host, presets: ctx.presets, project: existing };
}

export async function createRemoteProjectOnHost(
  sshTarget: string,
  directory: string,
  name?: string,
): Promise<RemoteProjectCreateResult> {
  try {
    const { host, presets, response } = await runRemoteRequest(sshTarget, {
      type: "project:create",
      directory,
      ...(name ? { name } : {}),
    });
    if (response.type !== "project:create-result") {
      throw new Error("Remote Aya returned an unexpected response.");
    }
    return {
      host,
      presets,
      project: requireProject(response.project),
    };
  } catch (err) {
    const recovered = recoverExistingRemoteProject(err);
    if (recovered) return recovered;
    throw err;
  }
}
