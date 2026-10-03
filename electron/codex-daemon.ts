// Interactive Codex runs the agent's shell commands in a shared `codex
// app-server daemon`, which keeps the env of whichever pane started it: every
// later pane's `aya` calls then carried THAT pane's AYA_TERMINAL_ID (measured on
// codex-cli 0.158.0). `--no-daemon` keeps the commands in the pane's own process.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import { cdLead, shellTokens, splitProgram, unquoteWord } from "./shell-words";

export const NO_DAEMON = "--no-daemon";
const CODEX_BINARY = /^(?:\S*\/)?codex(?=\s|$)/;
// Measured on 0.158.0: the top-level flag parses before any subcommand, so it
// goes right after the binary. These never start the TUI, so they are left alone.
export const NON_TUI = new Set([
  "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app",
  "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "queue", "archive", "delete",
  "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help", "agents",
]);

// From `codex --help` on 0.158.0: the options whose next word is their value.
export const VALUE_OPTIONS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image",
  "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir",
  "-a", "--ask-for-approval",
]);

/** The first word that is neither an option nor an option's value. */
export function firstPositional(words: string[], valueOptions: Set<string> = VALUE_OPTIONS): string | undefined {
  for (let i = 0; i < words.length; i += 1) {
    if (!words[i].startsWith("-")) return words[i];
    if (valueOptions.has(words[i])) i += 1;
  }
  return undefined;
}

/** The codex binary, its env assignments and the command with the flag, or
 *  null when the flag does not belong: another program, a non-TUI subcommand, already present. */
function tuiCodex(command: string): { binary: string; assignments: string[]; withFlag: string } | null {
  const at = cdLead(command)?.at ?? 0;
  if (at) {
    const codex = tuiCodex(command.slice(at));
    return codex && { ...codex, withFlag: command.slice(0, at) + codex.withFlag };
  }
  const { lead, assignments, program } = splitProgram(command);
  const binary = CODEX_BINARY.exec(program)?.[0];
  if (!binary) return null;
  const args = program.slice(binary.length);
  const words = shellTokens(args);
  if (words.includes(NO_DAEMON) || NON_TUI.has(firstPositional(words) ?? "")) return null;
  return { binary, assignments, withFlag: `${lead}${binary} ${NO_DAEMON}${args}` };
}

export function withNoDaemon(command: string): string {
  return tuiCodex(command)?.withFlag ?? command;
}

/** withNoDaemon, when `supports` says the codex this command runs has the flag. */
export async function noDaemonCommand(
  command: string,
  supports: (binary: string, assignments: string[]) => Promise<boolean>,
): Promise<string> {
  const codex = tuiCodex(command);
  if (!codex) return command;
  try {
    return (await supports(codex.binary, codex.assignments)) ? codex.withFlag : command;
  } catch {
    return command;
  }
}

const CODEX_BINARY_ENV = "AYA_CODEX_BINARY";
/** Fixed, so no preset text is on the probe's command line; the binary travels in the env. */
const CODEX_HELP_ARGV = ["-l", "-i", "-c", `exec "$${CODEX_BINARY_ENV}" --help`];

// Keyed by the installed file and its mtime and size, so each install has its
// own answer and a reinstall or upgrade is asked again.
const supportsCache = new Map<string, boolean>();

/** The file `binary` runs from `PATH`, as a cache key; null when only the login shell finds it. */
async function installedKey(binary: string, pathVar: string | undefined, cwd: string): Promise<string | null> {
  const candidates = binary.includes("/")
    ? [path.resolve(cwd, binary)]
    : (pathVar ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, binary));
  for (const candidate of candidates) {
    try {
      const file = await fs.realpath(candidate);
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.mode & 0o111) return `${file}\0${stat.mtimeMs}\0${stat.size}`;
    } catch {
      // not on this PATH entry
    }
  }
  return null;
}

/** stdout of a login-shell run, killed with its whole process group on its own timer: an rc
 *  that sleeps ignores SIGTERM to the shell, and one that reads stdin would never end. */
function runBounded(
  file: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ help: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(file, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ help: out, timedOut });
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(true);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(false));
  });
}

/** Whether `binary --help`, run through the pane's login shell, lists --no-daemon. A timeout adds the flag (an old codex
 *  is rare, the shared daemon's identity mix-up is not) and, like any empty answer, is not cached. */
export async function codexSupportsNoDaemon(
  shell: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  written: string,
  timeoutMs: number = COMMAND_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  // The probe passes the word through the env, where the shell would not expand ~ or $HOME.
  const binary = unquoteWord(written, env);
  const key = await installedKey(binary, env.PATH, cwd);
  const known = key === null ? undefined : supportsCache.get(key);
  if (known !== undefined) return known;
  const { help, timedOut } = await runBounded(shell, CODEX_HELP_ARGV, cwd, { ...env, [CODEX_BINARY_ENV]: binary }, timeoutMs);
  if (!help.trim()) return timedOut;
  const supported = help.includes(NO_DAEMON);
  if (key !== null) supportsCache.set(key, supported);
  return supported;
}
