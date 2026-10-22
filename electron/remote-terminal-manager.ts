import type { SpawnRequest, PtyEvent } from "./types";
import { RemoteTerminalClient } from "./remote-client";

type TerminalConnection = Pick<RemoteTerminalClient,
  "on" | "off" | "spawnTerminal" | "attach" | "write" | "resize" | "exit" | "detach"> & { killBridgeForTests?: () => void };

export const REMOTE_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class RemoteReconnectBackoff {
  private attempt = 0;
  next(): number {
    const delay = REMOTE_RECONNECT_DELAYS_MS[Math.min(this.attempt, REMOTE_RECONNECT_DELAYS_MS.length - 1)];
    this.attempt += 1;
    return delay;
  }
  reset(): void { this.attempt = 0; }
}

type CancelReconnect = () => void;

export interface RemoteTerminalManagerDeps {
  connect: (sshTarget: string) => TerminalConnection;
  sendEvent: (event: PtyEvent) => void;
  schedule?: (callback: () => void, delayMs: number) => CancelReconnect;
}

interface ManagedTerminal {
  sshTarget: string;
  hostLabel: string;
  remoteTerminalId: string;
  client: TerminalConnection | null;
  onOutput: (event: { terminalId: string; offset: number; data: string }) => void;
  onExit: (event: { terminalId: string; exitCode?: number; killed?: true }) => void;
  onError: (error: Error) => void;
  readOnly: boolean;
  outputOffset: number;
  exited: boolean;
  reconnect: RemoteReconnectBackoff;
  cancelReconnect?: CancelReconnect;
  connecting: boolean;
  established: boolean;
  reconnectEnabled: boolean;
}

/** Main-process lifecycle for a local view of a host-owned PTY. Detaching a
 * view closes only its bridge; the stable local tab id is also the v2 host id,
 * so a later mount can attach and request replay from the beginning. */
export class RemoteTerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly legacy = new Set<string>();

  constructor(private readonly deps: RemoteTerminalManagerDeps) {}

  has(ptyId: string): boolean { return this.terminals.has(ptyId); }

  dropBridgeForTests(ptyId: string): boolean {
    const client = this.terminals.get(ptyId)?.client;
    if (!client?.killBridgeForTests) return false;
    client.killBridgeForTests();
    return true;
  }

  async spawn(request: SpawnRequest, sshTarget: string, project: string, hostLabel = sshTarget): Promise<"remote" | "legacy"> {
    if (this.legacy.has(request.ptyId)) return "legacy";
    let existing = this.terminals.get(request.ptyId);
    if (existing?.client && (!existing.exited || request.attachOnly || request.attachIfReused)) {
      await this.attach(request.ptyId, existing);
      return "remote";
    }
    if (existing?.exited && !request.attachOnly && !request.attachIfReused) {
      await this.releaseClient(existing);
      this.terminals.delete(request.ptyId);
      existing = undefined;
    }
    // A pane explicitly restarted after its prior host session disappeared
    // must create a new PTY. An attach-only remount still probes the old id.
    if (existing && !request.attachOnly && !request.attachIfReused) {
      this.terminals.delete(request.ptyId);
    }

    const client = this.deps.connect(sshTarget);
    const terminal: ManagedTerminal = {
      sshTarget,
      hostLabel,
      remoteTerminalId: request.ptyId,
      client,
      readOnly: false,
      outputOffset: existing?.outputOffset ?? 0,
      exited: false,
      reconnect: existing?.reconnect ?? new RemoteReconnectBackoff(),
      connecting: false,
      established: existing?.established ?? false,
      reconnectEnabled: false,
      onOutput: (event) => {
        if (event.terminalId !== terminal.remoteTerminalId) return;
        terminal.outputOffset = Math.max(terminal.outputOffset, event.offset + Buffer.byteLength(event.data, "utf8"));
        this.deps.sendEvent({ type: "data", ptyId: request.ptyId, chunk: event.data });
      },
      onExit: (event) => {
        if (event.terminalId !== terminal.remoteTerminalId) return;
        terminal.exited = true;
        terminal.cancelReconnect?.(); terminal.cancelReconnect = undefined;
        this.deps.sendEvent(event.killed
          ? { type: "exit", ptyId: request.ptyId, exitCode: -1 }
          : { type: "exit", ptyId: request.ptyId, exitCode: event.exitCode ?? 0 });
      },
      onError: () => this.connectionLost(request.ptyId, terminal, client),
    };
    if (existing) this.terminals.set(request.ptyId, terminal);
    this.bind(request.ptyId, terminal, client);

    try {
      if (existing || request.attachOnly || request.attachIfReused) {
        this.terminals.set(request.ptyId, terminal);
        try {
          await this.attach(request.ptyId, terminal);
        } catch (error) {
          if (isMissingRemoteTerminal(error)) {
            await this.releaseClient(terminal);
            this.terminals.delete(request.ptyId);
            this.deps.sendEvent({ type: "no-session", ptyId: request.ptyId });
            return "remote";
          }
          throw error;
        }
      } else {
        await client.spawnTerminal(project, request.presetId ?? "", request.cols, request.rows, request.ptyId);
        this.terminals.set(request.ptyId, terminal);
        await this.attach(request.ptyId, terminal);
      }
      terminal.established = true;
      terminal.reconnectEnabled = true;
      return "remote";
    } catch (error) {
      this.unbind(terminal, client);
      if (terminal.client === client) terminal.client = null;
      await client.detach().catch(() => {});
      if (existing?.established && !isUnsupportedV2(error) && !isMissingRemoteTerminal(error)) {
        terminal.established = true;
        terminal.reconnectEnabled = true;
        this.terminals.set(request.ptyId, terminal);
        this.scheduleReconnect(request.ptyId, terminal);
        return "remote";
      }
      this.terminals.delete(request.ptyId);
      if (isUnsupportedV2(error)) {
        this.legacy.add(request.ptyId);
        this.deps.sendEvent({ type: "data", ptyId: request.ptyId, chunk: "\r\n[This remote host cannot keep terminals running after disconnect. Aya is using a direct SSH terminal; closing it ends the session.]\r\n" });
        return "legacy";
      }
      throw error;
    }
  }

  /** User-requested immediate retry. Automatic retries remain backoff-limited. */
  async reconnectNow(ptyId: string): Promise<boolean> {
    const terminal = this.terminals.get(ptyId);
    if (!terminal || terminal.exited) return false;
    terminal.cancelReconnect?.(); terminal.cancelReconnect = undefined;
    terminal.reconnect.reset();
    terminal.reconnectEnabled = true;
    this.deps.sendEvent({ type: "remote-connection", ptyId, host: terminal.hostLabel, connected: false, retryInMs: 0 });
    return this.tryReconnect(ptyId, terminal);
  }

  async write(ptyId: string, data: string): Promise<boolean | undefined> {
    const terminal = this.terminals.get(ptyId);
    if (!terminal) return undefined;
    if (!terminal.client) throw new Error("The remote terminal is disconnected. Reopen the pane to reconnect.");
    if (terminal.readOnly) throw new Error("Another Aya controls this host. You can watch, but not type.");
    return terminal.client.write(terminal.remoteTerminalId, data);
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<boolean> {
    const terminal = this.terminals.get(ptyId);
    if (!terminal) return false;
    if (!terminal.client) throw new Error("The remote terminal is disconnected. Reopen the pane to reconnect.");
    if (terminal.readOnly) throw new Error("Another Aya controls this host. You can watch, but not resize.");
    await terminal.client.resize(terminal.remoteTerminalId, cols, rows);
    return true;
  }

  async detach(ptyId: string): Promise<boolean> {
    const terminal = this.terminals.get(ptyId);
    if (!terminal) return false;
    await this.releaseClient(terminal);
    this.deps.sendEvent({ type: "remote-control", ptyId, controlled: false, readOnly: false });
    return true;
  }

  async end(ptyId: string): Promise<boolean> {
    const terminal = this.terminals.get(ptyId);
    if (!terminal) return false;
    if (!terminal.client) throw new Error("Reconnect to the remote terminal before ending it.");
    if (terminal.readOnly) throw new Error("Another Aya controls this host. You cannot end this terminal.");
    await terminal.client.exit(terminal.remoteTerminalId);
    await this.detach(ptyId);
    this.terminals.delete(ptyId);
    this.legacy.delete(ptyId);
    return true;
  }

  private async attach(ptyId: string, terminal: ManagedTerminal): Promise<void> {
    const client = terminal.client;
    if (!client) throw new Error("The remote terminal is disconnected.");
    const attached = await client.attach(terminal.remoteTerminalId, terminal.outputOffset);
    terminal.readOnly = attached.readOnly;
    terminal.outputOffset = Math.max(terminal.outputOffset, attached.endOffset);
    this.deps.sendEvent({ type: "remote-control", ptyId, controlled: false, readOnly: attached.readOnly });
  }

  private async releaseClient(terminal: ManagedTerminal): Promise<void> {
    terminal.cancelReconnect?.(); terminal.cancelReconnect = undefined;
    terminal.reconnectEnabled = false;
    const client = terminal.client;
    terminal.client = null;
    if (!client) return;
    client.off("output", terminal.onOutput);
    client.off("exit", terminal.onExit);
    client.off("error", terminal.onError);
    await client.detach();
  }

  private bind(ptyId: string, terminal: ManagedTerminal, client: TerminalConnection): void {
    terminal.client = client;
    terminal.onError = (error) => {
      if (isUnsupportedV2(error)) return;
      this.connectionLost(ptyId, terminal, client);
    };
    client.on("output", terminal.onOutput);
    client.on("exit", terminal.onExit);
    client.on("error", terminal.onError);
  }

  private unbind(terminal: ManagedTerminal, client: TerminalConnection): void {
    client.off("output", terminal.onOutput);
    client.off("exit", terminal.onExit);
    client.off("error", terminal.onError);
  }

  private connectionLost(ptyId: string, terminal: ManagedTerminal, client: TerminalConnection): void {
    if (terminal.client !== client || terminal.exited) return;
    terminal.client = null;
    this.unbind(terminal, client);
    if (!terminal.established || !terminal.reconnectEnabled) return;
    this.scheduleReconnect(ptyId, terminal);
  }

  private scheduleReconnect(ptyId: string, terminal: ManagedTerminal): void {
    if (terminal.cancelReconnect || terminal.connecting || terminal.exited || !terminal.reconnectEnabled) return;
    const retryInMs = terminal.reconnect.next();
    this.deps.sendEvent({ type: "remote-connection", ptyId, host: terminal.hostLabel, connected: false, retryInMs });
    const schedule = this.deps.schedule ?? ((callback: () => void, delayMs: number): CancelReconnect => {
      const timer = setTimeout(callback, delayMs); timer.unref?.(); return () => clearTimeout(timer);
    });
    terminal.cancelReconnect = schedule(() => {
      terminal.cancelReconnect = undefined;
      void this.tryReconnect(ptyId, terminal);
    }, retryInMs);
  }

  private async tryReconnect(ptyId: string, terminal: ManagedTerminal): Promise<boolean> {
    if (terminal.connecting || terminal.exited || !terminal.reconnectEnabled || this.terminals.get(ptyId) !== terminal) return false;
    terminal.connecting = true;
    let client: TerminalConnection | null = null;
    try {
      client = this.deps.connect(terminal.sshTarget);
      this.bind(ptyId, terminal, client);
      await this.attach(ptyId, terminal);
      terminal.established = true;
      terminal.connecting = false;
      terminal.reconnect.reset();
      this.deps.sendEvent({ type: "remote-connection", ptyId, host: terminal.hostLabel, connected: true });
      return true;
    } catch {
      terminal.connecting = false;
      if (client) {
        this.unbind(terminal, client);
        if (terminal.client === client) terminal.client = null;
        await client.detach().catch(() => {});
      }
      this.scheduleReconnect(ptyId, terminal);
      return false;
    }
  }
}

export function isUnsupportedV2(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not support terminal protocol version 2|did not accept terminal protocol version 2|uses protocol .* supports/i.test(message);
}

function isMissingRemoteTerminal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /remote terminal is no longer available/i.test(message);
}
