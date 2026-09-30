// Interactive Codex runs the agent's shell commands in a shared `codex
// app-server daemon`, which keeps the env of whichever pane started it: every
// later pane's `aya` calls then carried THAT pane's AYA_TERMINAL_ID (measured on
// codex-cli 0.158.0). `--no-daemon` keeps the commands in the pane's own process.

import { execFile } from "node:child_process";
import { COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import { leadingEnvAssignments } from "./shell-words";

const NO_DAEMON = "--no-daemon";
const CODEX_BINARY = /^(?:\S*\/)?codex(?=\s|$)/;
// Measured on 0.158.0: the top-level flag parses before any subcommand, so it
// goes right after the binary. These never start the TUI, so they are left alone.
const NON_TUI = new Set([
  "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app",
  "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "queue", "archive", "delete",
  "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help", "agents",
]);

/** The codex binary and the command split around it, or null when the flag
 *  does not belong: another program, a non-TUI subcommand, already present. */
function tuiCodex(command: string): { binary: string; withFlag: string } | null {
  const trimmed = command.trim();
  const { rest } = leadingEnvAssignments(trimmed);
  const program = trimmed.slice(rest);
  const binary = CODEX_BINARY.exec(program)?.[0];
  if (!binary) return null;
  const args = program.slice(binary.length);
  if (args.split(/\s+/).some((w) => w === NO_DAEMON || NON_TUI.has(w))) return null;
  return { binary, withFlag: `${trimmed.slice(0, rest)}${binary} ${NO_DAEMON}${args}` };
}

export function withNoDaemon(command: string): string {
  return tuiCodex(command)?.withFlag ?? command;
}

/** withNoDaemon, when `supports` says the installed codex has the flag. */
export async function noDaemonCommand(
  command: string,
  supports: (binary: string) => Promise<boolean>,
): Promise<string> {
  const codex = tuiCodex(command);
  if (!codex) return command;
  return (await supports(codex.binary).catch(() => false)) ? codex.withFlag : command;
}

// A yes holds for the process lifetime; a no is asked again, so an upgrade
// mid-session is picked up by the next pane.
const supportsCache = new Set<string>();

/** Whether `binary --help` lists --no-daemon, run through the pane's login shell. */
export async function codexSupportsNoDaemon(
  shell: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  binary: string,
): Promise<boolean> {
  if (supportsCache.has(binary)) return true;
  const help = await new Promise<string>((resolve) => {
    execFile(
      shell,
      ["-l", "-i", "-c", 'exec "$0" --help', binary],
      { cwd, env, timeout: COMMAND_PROBE_TIMEOUT_MS, windowsHide: true },
      (_err, stdout) => resolve(String(stdout)),
    );
  });
  const supported = help.includes(NO_DAEMON);
  if (supported) supportsCache.add(binary);
  return supported;
}
