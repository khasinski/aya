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
import { AYA_HOME } from "./paths";
import { bundledAyaCliPath } from "./cli-path";
import {
  claudeConfigDirs,
  readSettingsFile,
  settingsFileForConfigDir,
} from "./usage-hook";

// The generated hook script lives in Aya's own dir (always exists), referenced
// by absolute path from every hook entry.
export const STATUS_HOOK_SCRIPT_FILE = path.join(AYA_HOME, "aya-status-hook.sh");
// Executable mode for the generated script (rwxr-xr-x).
const HOOK_SCRIPT_MODE = 0o755;
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
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The command string registered in settings.json. Just the script by absolute
 *  path: it reads the hook event from stdin and the target pane from the
 *  AYA_* env the Claude process inherits from its Aya terminal. */
export function statusHookCommand(): string {
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
  const filtered = (h[event] as HookEntry[]).filter(
    (e) => !(Array.isArray(e?.hooks) && e.hooks.some((x) => x?.command === command)),
  );
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
    "$AYA" status waiting "$MSG" >/dev/null 2>&1 || true ;;
  PostToolUse)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // "a tool"')
    "$AYA" status active "running $TOOL" >/dev/null 2>&1 || true ;;
  Stop)
    "$AYA" status done "Turn finished" >/dev/null 2>&1 || true ;;
esac
exit 0
`;
}

// ---- fs-bound install / uninstall / status ----------------------------------

export async function statusHookStatus(): Promise<StatusHookStatus> {
  const command = statusHookCommand();
  let registered = true;
  const dirs = await claudeConfigDirs();
  for (const dir of dirs) {
    try {
      const settings = await readSettingsFile(settingsFileForConfigDir(dir));
      // Installed only when every status event carries our command.
      registered &&= STATUS_HOOK_EVENTS.every((event) =>
        hasEventHook(settings, event, command),
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

export async function installStatusHook(): Promise<StatusHookStatus> {
  const command = statusHookCommand();
  for (const dir of await claudeConfigDirs()) {
    const settingsPath = settingsFileForConfigDir(dir);
    const settings = await readSettingsFile(settingsPath);
    const next = withStatusHooks(settings, command);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + "\n");
  }
  await writeFileAtomic(
    STATUS_HOOK_SCRIPT_FILE,
    statusHookScriptSource(bundledAyaCliPath(__dirname)),
  );
  await fs.chmod(STATUS_HOOK_SCRIPT_FILE, HOOK_SCRIPT_MODE);
  return statusHookStatus();
}

export async function uninstallStatusHook(): Promise<StatusHookStatus> {
  const command = statusHookCommand();
  for (const dir of await claudeConfigDirs()) {
    try {
      const settingsPath = settingsFileForConfigDir(dir);
      const settings = await readSettingsFile(settingsPath);
      await writeFileAtomic(
        settingsPath,
        JSON.stringify(withoutStatusHooks(settings, command), null, 2) + "\n",
      );
    } catch {
      /* malformed/unreadable settings — leave it alone */
    }
  }
  await fs.rm(STATUS_HOOK_SCRIPT_FILE, { force: true });
  return statusHookStatus();
}
