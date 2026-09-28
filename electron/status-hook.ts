// Optional, user-enabled installer for AUTOMATIC agent status (#38).
//
// Claude Code's status in Aya is otherwise best-effort: a regex bell heuristic
// plus a VT screen mirror. This installer wires Claude Code's own lifecycle
// hooks straight into `aya status`, so a pane reliably reports what the agent
// is doing:
//   Notification -> waiting   (needs approval / your input)
//   PostToolUse  -> active    (running a tool)
//   Stop         -> done      (turn finished)
//
// IMPORTANT trust boundary: the hooks live in ~/.claude/settings.json and fire
// in EVERY Claude Code session, not only inside Aya. The generated script
// no-ops entirely when AYA_SOCKET / AYA_TERMINAL_ID are absent, so it does
// nothing outside an Aya terminal. Enabling is explicit (a Settings toggle with
// a disclosure dialog) and fully reversible.
//
// Mirrors electron/usage-hook.ts; it reuses that module's claude-settings
// plumbing so both installers touch exactly the same settings.json files.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AYA_HOME, EXECUTABLE_FILE_MODE } from "./paths";
import { bundledAyaCliPath } from "./cli-path";
import { HOOK_VIA } from "./constants";
import {
  claudeConfigDirs,
  readSettingsFile,
  settingsFileForConfigDir,
} from "./usage-hook";

// The generated hook script lives in Aya's own dir (always exists), referenced
// by absolute path from every hook entry.
export const STATUS_HOOK_SCRIPT_FILE = path.join(AYA_HOME, "aya-status-hook.sh");
// The Claude Code hook events we register our command under.
export const STATUS_HOOK_EVENTS = [
  "Notification",
  "PostToolUse",
  "Stop",
] as const;

export interface StatusHookStatus {
  installed: boolean;
  /** Absolute path to the generated script (whether or not it exists yet). */
  scriptPath: string;
  /** Where the hooks are registered. */
  settingsPath: string;
  /** Codex half of the same toggle (#38): its `notify` program. Filled in by
   *  main.ts (this Claude-side module doesn't know about Codex). `configured` =
   *  ours is set; `conflict` = the user already has their own notify, left
   *  untouched. */
  codex?: {
    configured: boolean;
    conflict: boolean;
    configPath: string;
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Characters a POSIX shell word can hold unquoted.
const SHELL_SAFE_RE = /^[A-Za-z0-9_\/.,:@%+=-]+$/;

/** A script path as a hook command: bare when the shell needs no quotes. Grok
 *  runs a command with no space as a file path, so a quoted bare path fails there. */
export function hookCommandFor(scriptPath: string): string {
  return SHELL_SAFE_RE.test(scriptPath) ? scriptPath : shellQuote(scriptPath);
}

/** The command string registered in settings.json: the script by absolute path.
 *  It reads the event from stdin and the pane from the inherited AYA_* env. */
export function statusHookCommand(): string {
  return hookCommandFor(STATUS_HOOK_SCRIPT_FILE);
}

/** Written before hookCommandFor: always quoted. Migrated at startup, removed on uninstall. */
function legacyStatusHookCommand(): string {
  return shellQuote(STATUS_HOOK_SCRIPT_FILE);
}

// ---- pure settings.json merge/unmerge (the risky part — unit-tested) --------

type HookEntry = { hooks?: Array<{ type?: string; command?: string }> };

function eventArray(settings: unknown, event: string): HookEntry[] | null {
  if (typeof settings !== "object" || settings === null) return null;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return null;
  const arr = (hooks as Record<string, unknown>)[event];
  return Array.isArray(arr) ? (arr as HookEntry[]) : null;
}

/** True if `settings` already registers `command` under `event`. */
export function hasEventHook(
  settings: unknown,
  event: string,
  command: string,
): boolean {
  const arr = eventArray(settings, event);
  if (!arr) return false;
  return arr.some(
    (e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command === command),
  );
}

/** A NEW settings object with `command` added under `event` (idempotent),
 *  leaving every other key — and any other hooks — untouched. */
export function withEventHook(
  settings: Record<string, unknown>,
  event: string,
  command: string,
): Record<string, unknown> {
  if (hasEventHook(settings, event, command)) return settings;
  const hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}) };
  const arr = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  arr.push({ hooks: [{ type: "command", command }] });
  return { ...settings, hooks: { ...hooks, [event]: arr } };
}

/** A NEW settings object with our `command` removed from `event`, leaving
 *  everything else intact. Drops now-empty containers so we leave no litter,
 *  but never touches other people's hooks. */
export function withoutEventHook(
  settings: Record<string, unknown>,
  event: string,
  command: string,
): Record<string, unknown> {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return settings;
  const h = hooks as Record<string, unknown>;
  if (!Array.isArray(h[event])) return settings;
  const filtered = (h[event] as HookEntry[]).flatMap((e) => {
    if (!Array.isArray(e?.hooks) || !e.hooks.some((x) => x?.command === command)) return [e];
    const rest = e.hooks.filter((x) => x?.command !== command);
    return rest.length > 0 ? [{ ...e, hooks: rest }] : [];
  });
  const nextHooks: Record<string, unknown> = { ...h };
  if (filtered.length > 0) nextHooks[event] = filtered;
  else delete nextHooks[event];
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

/** Add our command under every status event (idempotent). */
export function withStatusHooks(
  settings: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  return STATUS_HOOK_EVENTS.reduce(
    (acc, event) => withEventHook(acc, event, command),
    settings,
  );
}

/** Remove our command from every status event. */
export function withoutStatusHooks(
  settings: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  return STATUS_HOOK_EVENTS.reduce(
    (acc, event) => withoutEventHook(acc, event, command),
    settings,
  );
}

/** Our old `legacy` command swapped for `command` under each event that has it;
 *  the same object back when none does, so nothing is ever installed. */
export function withMigratedStatusHooks(
  settings: Record<string, unknown>,
  legacy: string,
  command: string,
): Record<string, unknown> {
  if (legacy === command) return settings;
  return STATUS_HOOK_EVENTS.reduce(
    (acc, event) =>
      hasEventHook(acc, event, legacy) ? withEventHook(withoutEventHook(acc, event, legacy), event, command) : acc,
    settings,
  );
}

// ---- the generated hook script ----------------------------------------------

/** The shell script every hook runs. Reads the Claude hook JSON on stdin, maps
 *  the event to `aya status`, and no-ops outside an Aya terminal. `ayaCli` is
 *  the fallback path to the bundled CLI when `aya` is not on PATH. */
export function statusHookScriptSource(ayaCli: string): string {
  return `#!/usr/bin/env bash
# Auto-generated by Aya (Settings -> automatic status). Reports Claude Code's
# turn state into the Aya pane it runs in, via \`aya status\`. It reads the hook
# event from stdin and no-ops entirely outside an Aya terminal (AYA_SOCKET /
# AYA_TERMINAL_ID unset), so it does nothing in Claude sessions run elsewhere.
# Remove it from Aya Settings.
set -euo pipefail
[ -n "\${AYA_SOCKET:-}" ] || exit 0
[ -n "\${AYA_TERMINAL_ID:-}" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
AYA=$(command -v aya 2>/dev/null || true)
[ -n "$AYA" ] || AYA=${JSON.stringify(ayaCli)}
[ -x "$AYA" ] || exit 0
INPUT=$(cat)
EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty')
case "$EVENT" in
  Notification)
    MSG=$(printf '%s' "$INPUT" | jq -r '.message // "Needs your input"')
    AYA_VIA=${HOOK_VIA} "$AYA" status waiting "$MSG" >/dev/null 2>&1 || true ;;
  PostToolUse)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // "a tool"')
    AYA_VIA=${HOOK_VIA} "$AYA" status active "running $TOOL" >/dev/null 2>&1 || true ;;
  Stop)
    AYA_VIA=${HOOK_VIA} "$AYA" status done "Turn finished" >/dev/null 2>&1 || true ;;
esac
exit 0
`;
}

// ---- fs-bound install / uninstall / status ----------------------------------

// Startup migration runs unawaited; queue it with install/uninstall so no edit is lost.
let settingsEdits: Promise<unknown> = Promise.resolve();
function serially<T>(edit: () => Promise<T>): Promise<T> {
  const run = settingsEdits.then(edit, edit);
  settingsEdits = run.catch(() => {});
  return run;
}

export async function statusHookStatus(): Promise<StatusHookStatus> {
  const [command, legacy] = [statusHookCommand(), legacyStatusHookCommand()];
  let registered = true;
  const dirs = await claudeConfigDirs();
  for (const dir of dirs) {
    try {
      const settings = await readSettingsFile(settingsFileForConfigDir(dir));
      // Installed only when every status event carries our command.
      registered &&= STATUS_HOOK_EVENTS.every(
        (event) => hasEventHook(settings, event, command) || hasEventHook(settings, event, legacy),
      );
    } catch {
      registered = false;
    }
  }
  let scriptExists = false;
  try {
    await fs.access(STATUS_HOOK_SCRIPT_FILE);
    scriptExists = true;
  } catch {
    scriptExists = false;
  }
  return {
    installed: registered && scriptExists,
    scriptPath: STATUS_HOOK_SCRIPT_FILE,
    settingsPath: dirs.map(settingsFileForConfigDir).join(", "),
  };
}

async function install(): Promise<StatusHookStatus> {
  const command = statusHookCommand();
  for (const dir of await claudeConfigDirs()) {
    const settingsPath = settingsFileForConfigDir(dir);
    const settings = await readSettingsFile(settingsPath);
    const next = withStatusHooks(withoutStatusHooks(settings, legacyStatusHookCommand()), command);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + "\n");
  }
  await writeFileAtomic(
    STATUS_HOOK_SCRIPT_FILE,
    statusHookScriptSource(bundledAyaCliPath(__dirname)),
  );
  await fs.chmod(STATUS_HOOK_SCRIPT_FILE, EXECUTABLE_FILE_MODE);
  return statusHookStatus();
}

async function uninstall(): Promise<StatusHookStatus> {
  const command = statusHookCommand();
  for (const dir of await claudeConfigDirs()) {
    try {
      const settingsPath = settingsFileForConfigDir(dir);
      const settings = await readSettingsFile(settingsPath);
      const without = withoutStatusHooks(withoutStatusHooks(settings, command), legacyStatusHookCommand());
      await writeFileAtomic(settingsPath, JSON.stringify(without, null, 2) + "\n");
    } catch {
      /* malformed/unreadable settings — leave it alone */
    }
  }
  await fs.rm(STATUS_HOOK_SCRIPT_FILE, { force: true });
  return statusHookStatus();
}

/** Rewrite an ALREADY-installed hook script whose content is out of date (e.g.
 *  written before hook calls were tagged AYA_VIA=hook, #121). Never installs:
 *  a missing script stays missing. */
export function refreshStatusHookScript(): Promise<void> {
  return refreshInstalledScript(STATUS_HOOK_SCRIPT_FILE, statusHookScriptSource(bundledAyaCliPath(__dirname)));
}

/** Rewrites `file` with `source` (executable) only when it exists and differs. */
export async function refreshInstalledScript(file: string, source: string): Promise<void> {
  let current: string;
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  if (current === source) return;
  await writeFileAtomic(file, source);
  await fs.chmod(file, EXECUTABLE_FILE_MODE);
}

async function migrate(): Promise<void> {
  const [legacy, command] = [legacyStatusHookCommand(), statusHookCommand()];
  for (const dir of await claudeConfigDirs()) {
    const settingsPath = settingsFileForConfigDir(dir);
    try {
      const settings = await readSettingsFile(settingsPath);
      const next = withMigratedStatusHooks(settings, legacy, command);
      if (next !== settings) await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + "\n");
    } catch {
      /* malformed or unwritable settings: leave this dir, migrate the rest */
    }
  }
}

export const installStatusHook = (): Promise<StatusHookStatus> => serially(install);
export const uninstallStatusHook = (): Promise<StatusHookStatus> => serially(uninstall);
/** Rewrite an installed quoted command to the current one (see hookCommandFor).
 *  Never installs: settings without our old command are left as they are. */
export const migrateStatusHookCommand = (): Promise<void> => serially(migrate);
