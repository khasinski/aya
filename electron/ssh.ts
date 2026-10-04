// The one place Aya runs a non-interactive ssh command: remote projects and machines alike.

import { spawn } from "node:child_process";

/** A `Host` alias as ~/.ssh/config spells one. */
export const SSH_ALIAS_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
/** An alias, a host name, or `user@host`; never starts with "-", so it cannot read as an option. */
export const SSH_TARGET_PATTERN = /^(?:[A-Za-z0-9._][A-Za-z0-9._+-]*@)?[A-Za-z0-9._][A-Za-z0-9._-]*$/;
export const SSH_CONNECT_TIMEOUT_S = 5;
/** The target's config may add forwards (a public LocalForward), a LocalCommand or a shared master: Aya's commands get none,
 *  and BatchMode so a password prompt fails at once instead of hanging with no terminal to type in. */
export const SSH_OPTIONS = [
  "BatchMode=yes",
  `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
  "ClearAllForwardings=yes",
  "PermitLocalCommand=no",
  "ForwardAgent=no",
  "ForwardX11=no",
  "ControlMaster=no",
  "ControlPath=none",
  "Tunnel=no",
  "RequestTTY=no",
];
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export function isSshTarget(value: string): boolean {
  return SSH_TARGET_PATTERN.test(value);
}

/** The trimmed target, or an error that says what a target looks like. */
export function requireSshTarget(value: string): string {
  const target = value.trim();
  if (!target) throw new Error("Remote SSH target is required.");
  if (!isSshTarget(target)) throw new Error(`"${target}" is not an ssh target: use a Host alias from ~/.ssh/config or user@host`);
  return target;
}

export function sshArgs(target: string, remoteCommand: string[]): string[] {
  return [...SSH_OPTIONS.flatMap((o) => ["-o", o]), "--", requireSshTarget(target), ...remoteCommand];
}

export interface SshRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** ssh itself could not be started (not installed). */
  spawnError: string | null;
}

export interface SshRunOptions {
  /** Written to the remote command's stdin, so the remote login shell never parses it. */
  input?: string;
  deadlineMs: number;
  maxOutputBytes?: number;
}

const seconds = (ms: number) => `${ms / 1000}s`;

/** Runs `ssh <hardened options> -- <target> <remoteCommand>`; at the deadline its whole process group gets SIGKILL. */
export function runSsh(target: string, remoteCommand: string[], options: SshRunOptions): Promise<SshRun> {
  const args = sshArgs(target, remoteCommand);
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (r: Omit<SshRun, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Own process group: a ProxyCommand child holding our pipes dies with ssh at the deadline.
      child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolve({ code: null, stdout, stderr, timedOut, spawnError: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // A grandchild outside the group may still hold the pipes: answer now, not at their close.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ code: null, spawnError: null });
    }, options.deadlineMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
    });
    child.stdin?.on("error", () => {});
    child.on("error", (err) => settle({ code: null, spawnError: err.message }));
    child.on("close", (code) => settle({ code, spawnError: null }));
    child.stdin?.end(options.input ?? "");
  });
}

/** Why ssh itself failed, or null when ssh connected and the remote command answered (whatever its exit code). */
export function sshFailure(run: SshRun, target: string, deadlineMs: number): string | null {
  if (run.spawnError) return `ssh could not be started: ${run.spawnError}`;
  if (run.timedOut) return `ssh ${target} did not finish within ${seconds(deadlineMs)}.`;
  // 255 is ssh's own exit code: connection, host key or authentication.
  if (run.code !== 255) return null;
  return lastStderrLine(run.stderr) ?? `ssh ${target} exited with 255`;
}

/** The last line ssh or the remote command printed on stderr, which names the reason. */
export function lastStderrLine(stderr: string): string | null {
  const line = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return line ? `ssh: ${line.replace(/^ssh:\s*/, "")}` : null;
}
