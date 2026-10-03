import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as net from "node:net";

const CLI = new URL("../../bin/aya", import.meta.url).pathname;

// The shells bin/aya must run under: macOS /bin/sh is bash 3.2 in POSIX mode, Debian's is
// dash, and /bin/bash on macOS is 3.2 itself.
export const CLI_SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"];

const programs = new Map();

/** What actually runs: the bash or zsh version it reports, else the binary behind the path
 *  (Debian's /bin/sh and /bin/dash are one dash). */
export function programOf(shell) {
  if (!programs.has(shell)) {
    let version = "";
    try {
      version = execFileSync(shell, ["-c", 'printf "%s|%s" "${BASH_VERSION:-}" "${ZSH_VERSION:-}"'], { encoding: "utf8", timeout: 5000 });
    } catch {}
    const [bash, zsh] = version.split("|");
    programs.set(shell, bash ? `bash ${bash}` : zsh ? `zsh ${zsh}` : realpathSync(shell));
  }
  return programs.get(shell);
}

/** The shell listed before `shell` in `shells` that is the same program, or null. */
export function sameProgramBefore(shell, shells = CLI_SHELLS) {
  const program = programOf(shell);
  return shells.slice(0, shells.indexOf(shell)).find((s) => existsSync(s) && programOf(s) === program) ?? null;
}

/** node:test options that skip, with the reason, a shell this machine lacks or one that is the
 *  same program as an earlier one (macOS /bin/bash is its /bin/sh), so the matrix never shrinks silently. */
export function shellOptions(shell, shells = CLI_SHELLS) {
  if (!existsSync(shell)) return { skip: `${shell} is not installed here, so it is not exercised` };
  const same = sameProgramBefore(shell, shells);
  return same ? { skip: `${shell} is the same program as ${same} (${programOf(shell)}), exercised there` } : {};
}

/** The installed shells of `shells`, each program once. */
export const distinctShells = (shells) => shells.filter((s) => existsSync(s) && !sameProgramBefore(s, shells));

/** A control socket that records each request and acks it after `delayMs`. */
export function stubApp(socket, delayMs = 0) {
  const requests = [];
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      requests.push(JSON.parse(buffer.slice(0, newline)));
      buffer = "";
      setTimeout(() => conn.end(`${JSON.stringify({ ok: true })}\n`), delayMs);
    });
  });
  return new Promise((done) => server.listen(socket, () => done({ server, requests, close: () => new Promise((r) => server.close(r)) })));
}

/** bin/aya `args` under `shell`: its exit status and stderr. */
export function runCli(shell, args, env) {
  return new Promise((done, fail) => {
    const child = spawn(shell, [CLI, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stderr }));
  });
}
