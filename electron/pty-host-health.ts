// One account of the terminal host's state, for every place that judges it: Aya's launch (is the host stale?), the
// red dot on Restart Aya, and Settings > Diagnostics. On 2026-10-13 a host ran with no pty-host.sock, and a second
// host held duplicate agents no window showed; Diagnostics printed the raw facts without saying either was wrong.

import * as net from "node:net";
import type { HostRecord } from "./pty-host-registry";
import { isHostStale, type HostIdentity } from "./pty-host-staleness";

/** How long the socket probe waits for the host on pty-host.sock to answer. */
export const SOCKET_PROBE_TIMEOUT_MS = 1_000;

export interface OtherHost {
  pid: number;
  startTime: string;
  version: string;
}

export interface HostHealth {
  /** The host this Aya talks to, or null when it talks to none. */
  pid: number | null;
  identity: HostIdentity | null;
  expected: HostIdentity;
  ptyCount: number;
  stale: boolean;
  socket: {
    exists: boolean;
    /** The host answering on pty-host.sock, or null when none answers. */
    pid: number | null;
  };
  /** Verified running hosts this Aya does not use and that are not on the socket: their terminals show nowhere. */
  otherHosts: OtherHost[];
  warnings: string[];
}

export interface HostHealthDeps {
  expected: HostIdentity;
  /** Whether this Aya is connected to a host now. */
  connected(): boolean;
  status(): Promise<{ identity: HostIdentity | null; ptyCount: number; pid?: number }>;
  socketExists(): Promise<boolean>;
  /** The pid of the host answering on pty-host.sock, without starting one; null when none answers. */
  probeSocket(): Promise<number | null>;
  liveRecords(): HostRecord[];
}

export async function gatherHostHealth(deps: HostHealthDeps): Promise<HostHealth> {
  const socketExists = await deps.socketExists();
  // Asking a client that is not connected while no socket exists would start a host: there is none to describe.
  const asked = deps.connected() || socketExists;
  const status = asked ? await deps.status() : { identity: null, ptyCount: 0, pid: undefined };
  const pid = typeof status.pid === "number" ? status.pid : null;
  const socketPid = socketExists ? await deps.probeSocket() : null;
  const known = new Set([pid, socketPid]);
  const otherHosts = deps
    .liveRecords()
    .filter((rec) => !known.has(rec.pid))
    .map((rec) => ({ pid: rec.pid, startTime: rec.startTime, version: rec.version }));
  const health: Omit<HostHealth, "warnings"> = {
    pid,
    identity: status.identity,
    expected: deps.expected,
    ptyCount: status.ptyCount,
    stale: asked && isHostStale(deps.expected, status.identity),
    socket: { exists: socketExists, pid: socketPid },
    otherHosts,
  };
  return { ...health, warnings: hostWarnings(health) };
}

/** What is wrong, in the words Diagnostics shows; empty when nothing is. */
export function hostWarnings(health: Omit<HostHealth, "warnings">): string[] {
  const warnings: string[] = [];
  if (health.stale) {
    warnings.push(
      `The terminal host runs an older Aya build (${health.identity?.version ?? "unknown version"}): restart it to use this one.`,
    );
  }
  if (health.pid !== null && !health.socket.exists) {
    warnings.push(
      `The terminal host (pid ${health.pid}) has no pty-host.sock: the next Aya start will start a second host and resume every agent again. Restart the PTY host now.`,
    );
  } else if (health.pid !== null && health.socket.pid !== null && health.socket.pid !== health.pid) {
    warnings.push(
      `pty-host.sock leads to another terminal host (pid ${health.socket.pid}) than the one this Aya uses (pid ${health.pid}).`,
    );
  }
  if (health.otherHosts.length > 0) {
    const pids = health.otherHosts.map((host) => host.pid).join(", ");
    warnings.push(
      health.otherHosts.length === 1
        ? `1 other terminal host still runs (pid ${pids}): its terminals show in no window. Stop it with Stop other hosts.`
        : `${health.otherHosts.length} other terminal hosts still run (pid ${pids}): their terminals show in no window. Stop them with Stop other hosts.`,
    );
  }
  return warnings;
}

/** The pid of the host answering on `socketPath`, or null when nothing answers in time. Never starts a host. */
export function probeSocketPid(socketPath: string, timeoutMs: number = SOCKET_PROBE_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const done = (pid: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(pid);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const socket = net.createConnection(socketPath, () => {
      socket.write(`${JSON.stringify({ id: 1, type: "version" })}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as { result?: { pid?: unknown } };
        const pid = reply.result?.pid;
        done(typeof pid === "number" && Number.isInteger(pid) && pid > 1 ? pid : null);
      } catch {
        done(null);
      }
    });
    socket.on("error", () => done(null));
  });
}
