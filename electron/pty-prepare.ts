import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnRequest } from "./types";
import {
  pathWithFallbackDir,
  shellQuote,
  simpleCommand,
  withoutSessionMarkers,
} from "./pane-command";
import { AYA_HOME, CONTROL_SOCKET_PATH } from "./paths";
import { codexSupportsNoDaemon, noDaemonCommand } from "./codex-daemon";
import { paneLaunchRecord, readLaunchConfig } from "./launch-config";
import { teamLaunch, withLaunchArgs } from "./launch-mode";
import { commandExists, preflightBinary } from "./command-probe";
import { userShell } from "./shell";
import { ptyLog } from "./pty-log";
import { bundledAyaCliPath } from "./cli-path";
import { envWithAssignments, leadingEnvAssignments, startsWithExec } from "./shell-words";
import { listOpencodeSessions, ownSessionCommand } from "./opencode-session";
import { shellClaudeConfigDir, watchClaudeSession, withLiveClaudeResume } from "./claude-session";
import {
  pollSession,
  processFamily,
  readCodexSessionId,
  readGrokSessionId,
  withLiveCodexResume,
  withLiveGrokResume,
  withOwnSessionId,
} from "./agent-session";
import { codexHomeFor } from "./agent-brief";
import { DEFAULT_CODEX_HOME } from "./usage-codex";
import { DEFAULT_GROK_HOME } from "./usage-grok";
import { expandUserPath } from "./usage";
import { PANE_ENV_VARS } from "./pane-env";

import type { PreparedSpawn } from "./pty-core";

// exec would replace the shell with the program, or with `cd`'s /usr/bin twin.
const NOT_EXECABLE = /^(?:[({]|(?:cd|export|source|\.|alias|eval|set|unset|umask|ulimit|pushd|popd|builtin)(?:\s|$)|command(?:\s+-|\s*$))/;

function commandWithExec(command: string): string {
  if (!command.trim()) return "exec";
  const { assignments, end, rest } = leadingEnvAssignments(command);
  const program = command.slice(rest).trim();
  if (!simpleCommand(command) || NOT_EXECABLE.test(program) || startsWithExec(program)) return command;
  // `exec command x` needs a /usr/bin/command (not on Linux); `command` only skips functions and aliases.
  const target = program.replace(/^command\s+/, "");
  if (!assignments.length) return `exec ${target}`;
  if (rest >= command.length) return command;
  return `${command.slice(0, end)} exec ${commandForExec(target)}`;
}

function commandForExec(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "$SHELL") {
    return "env -u EDITOR -u VISUAL $SHELL";
  }
  return command;
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\\(.)/g, "$1");
}

function expandConfigDir(value: string, cwd: string): string {
  const home = os.homedir();
  const unquoted = unquoteEnvValue(value.trim());
  return path.resolve(
    cwd,
    unquoted
      .replace(/^~(?=\/|$)/, home)
      .replace(/^\$HOME(?=\/|$)/, home)
      .replace(/^\$\{HOME\}(?=\/|$)/, home),
  );
}

/** Config dirs a command sets in leading assignments (only `keys`, in order);
 *  relative ones resolve against `cwd`. */
export function agentConfigDirsFromCommand(
  command: string,
  cwd: string,
  keys: readonly string[] = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"],
): string[] {
  const dirs: string[] = [];
  for (const token of leadingEnvAssignments(command).assignments) {
    const [, key = "", value = ""] = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s) ?? [];
    if (keys.includes(key)) {
      dirs.push(expandConfigDir(value, cwd));
    }
  }
  return dirs;
}

/** The user's login + interactive shell, so launchers defined as rc-file functions or PATH edits (which a
 *  non-interactive shell skips) still run. */
export function shellArgv(command: string, cwd: string): string[] {
  const cwdQuoted = shellQuote(cwd);
  // The user's command is embedded verbatim so $VARS / quoting / pipes work.
  // It must NOT be shell-quoted, or the shell would treat the whole thing
  // as one literal token.
  return [userShell(), "-l", "-i", "-c", `cd ${cwdQuoted} && ${commandWithExec(commandForExec(command))}`];
}

const codexHomeOf = (req: SpawnRequest, cwd: string) =>
  codexHomeFor({ configDir: req.agentConfigDir, command: req.command }, DEFAULT_CODEX_HOME, expandUserPath, cwd);

/** The dir the command itself sets for claude; a preset's configDir is only a label, the pane's env decides. */
function claudeDirInCommand(req: SpawnRequest, cwd: string): string | undefined {
  return agentConfigDirsFromCommand(req.command, cwd, ["CLAUDE_CONFIG_DIR"]).at(-1);
}

// The shell keeps the last assignment in a command.
function grokHomeOf(req: SpawnRequest, cwd: string): string {
  const dir = req.agentConfigDir ?? agentConfigDirsFromCommand(req.command, cwd, ["GROK_HOME"]).at(-1);
  return dir ? expandUserPath(dir) : DEFAULT_GROK_HOME;
}

const ownSession = (command: string) => {
  const own = withOwnSessionId(command);
  return { command: own.command, ownSessionId: own.sessionId };
};

/** The command to run: each agent's check that its session to resume still exists, or the pane's own session id for
 *  a fresh claude or grok; opencode's goes through the pane's shell, whose startup files may build its PATH. */
async function resolveSpawnCommand(
  req: SpawnRequest,
  cwd: string,
): Promise<{ command: string; ownSessionId: string | null }> {
  if (req.agent === "claude") {
    return ownSession(await withLiveClaudeResume(
      req.command,
      claudeDirInCommand(req, cwd),
      cwd,
      () => shellClaudeConfigDir(userShell(), cwd, safeEnv(req, cwd)),
      (err) => ptyLog.append("claude-config-dir-probe-failed", { ptyId: req.ptyId, error: err.message }),
    ));
  }
  if (req.agent === "codex") {
    const home = codexHomeOf(req, cwd);
    const onError = (err: Error) =>
      ptyLog.append("codex-resume-check-failed", { ptyId: req.ptyId, error: err.message });
    return { command: home ? await withLiveCodexResume(req.command, home, onError) : req.command, ownSessionId: null };
  }
  if (req.agent === "grok") return ownSession(await withLiveGrokResume(req.command, grokHomeOf(req, cwd), cwd));
  const command = await ownSessionCommand(
    req.command,
    cwd,
    (dir, assignments) => listOpencodeSessions(userShell(), dir, envWithAssignments(safeEnv(req, cwd), assignments)),
    (err) => ptyLog.append("opencode-session-lookup-failed", { ptyId: req.ptyId, error: String(err) }),
    () => ptyLog.append("opencode-session-none", { ptyId: req.ptyId }),
  );
  return { command, ownSessionId: null };
}

/** Reports the conversation a pane's agent is in, as the status hook would. */
export function watchAgentSession(
  req: SpawnRequest,
  cwd: string,
  pid: number,
  spawnedAt: number,
  report: (sessionId: string) => void,
): () => void {
  const onError = (err: Error) =>
    ptyLog.append("agent-session-read-failed", { ptyId: req.ptyId, agent: req.agent, error: err.message });
  if (req.agent === "claude") {
    return watchClaudeSession(claudeDirInCommand(req, cwd), pid, report, undefined, cwd, spawnedAt);
  }
  if (req.agent === "codex") {
    const home = codexHomeOf(req, cwd);
    if (!home) return () => {};
    return pollSession(async () => readCodexSessionId(home, cwd, await processFamily(pid), spawnedAt), report, undefined, onError);
  }
  if (req.agent === "grok") {
    const home = grokHomeOf(req, cwd);
    return pollSession(async () => readGrokSessionId(home, await processFamily(pid), spawnedAt), report, undefined, onError);
  }
  return () => {};
}

const DEFAULT_LANG = "en_US.UTF-8";
const PANE_TERM = "xterm-256color";
// Aya's own switches for the process that runs it: passed on, a nested Aya or
// Electron tool started from a pane would change mode. AYA_REMOTE_SOCKET stays, `aya` reads it.
const PANE_UNSHARED_VARS = [
  "ELECTRON_RUN_AS_NODE",
  "AYA_DEV",
  "AYA_E2E_HEADLESS",
  "AYA_E2E_PTY_SHUTDOWN",
  "AYA_E2E_APPLE_HELPER",
  "AYA_CLAUDE_SETTINGS",
];
// The spawn log clamps the command: it is unbounded user input, and one line past
// the log cap would blow straight through it (#89); 4 KB keeps real commands whole.
export const SPAWN_LOG_COMMAND_MAX_CHARS = 4096;

export function safeEnv(req: SpawnRequest, cwd: string): { [key: string]: string } {
  const inherited: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") inherited[k] = v;
  }
  const out = withoutSessionMarkers(inherited);
  for (const key of PANE_UNSHARED_VARS) delete out[key];
  out.TERM = PANE_TERM;
  out.COLORTERM = "truecolor";
  if (!out.LANG) out.LANG = DEFAULT_LANG;
  if (!out.LC_ALL) out.LC_ALL = out.LANG;
  // The bundled CLI as a PATH fallback, so `aya` works in every pane even
  // without the Settings shim; an installed shim earlier on PATH still wins.
  out.PATH = pathWithFallbackDir(out.PATH, path.dirname(bundledAyaCliPath(__dirname)));
  out.AYA_HOME = AYA_HOME;
  out.AYA_SOCKET = CONTROL_SOCKET_PATH;
  // Never the outer Aya pane's (a nested Aya): aya team save would fall back to its project.
  for (const key of PANE_ENV_VARS) delete out[key];
  out.AYA_TERMINAL_ID = req.ptyId;
  out.AYA_PROJECT_DIR = cwd;
  if (req.projectSlug) out.AYA_PROJECT_SLUG = req.projectSlug;
  if (req.presetId) out.AYA_PRESET_ID = req.presetId;
  return out;
}

/** A role's pane gets what makes it reach Aya; one Aya would have to escalate launches as its preset says. */
async function roleLaunch(ptyId: string, command: string, cwd: string, env: Record<string, string>): Promise<{ command: string; added: string[] }> {
  const launch = teamLaunch(command, await readLaunchConfig(command, cwd, env, CONTROL_SOCKET_PATH));
  if ("args" in launch) return { command: withLaunchArgs(command, launch.args), added: launch.args };
  ptyLog.append("team-launch-refused", { ptyId, reason: launch.refused });
  return { command, added: [] };
}


/** All agent and config decisions run in main, after the host reserves the spawn flight. */
export async function prepareSpawn(req: SpawnRequest, cwd: string, signal?: AbortSignal): Promise<PreparedSpawn> {
  const cancelled = (): PreparedSpawn => ({ failure: { reason: "spawn-prepare-failed", message: "Terminal preparation was cancelled." } });
  if (signal?.aborted) return cancelled();
  if (!req.command?.trim()) return { failure: { reason: "preset-empty-command", message: "preset has no command - edit it in Settings." } };
  for (const dir of agentConfigDirsFromCommand(req.command, cwd)) {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (err) { return { failure: { reason: "agent-config-dir-create-failed", message: `cannot create agent config directory: ${dir}\n${String(err)}` } }; }
  }
  const binary = preflightBinary(req.command);
  if (binary && !(await commandExists(binary, cwd))) {
    return { failure: { reason: "command-not-found", message: `command not found: ${binary}\nEdit the preset, install the CLI, or re-scan installed CLIs.` } };
  }
  if (signal?.aborted) return cancelled();
  const spawnedAt = Date.now();
  const { command: resumed, ownSessionId } = await resolveSpawnCommand(req, cwd);
  if (signal?.aborted) return cancelled();
  const env = safeEnv(req, cwd);
  const plain = await noDaemonCommand(resumed, (codex, assignments) =>
    codexSupportsNoDaemon(userShell(), cwd, envWithAssignments(env, assignments), codex));
  if (signal?.aborted) return cancelled();
  const { command, added } = req.teamLaunch ? await roleLaunch(req.ptyId, plain, cwd, env) : { command: plain, added: [] };
  const launch = await paneLaunchRecord(command, cwd, added, env, CONTROL_SOCKET_PATH);
  return { argv: shellArgv(command, cwd), env, command, launch, ownSessionId, spawnedAt };
}
