// Optional, user-enabled installer for the account-wide Claude usage chip.
//
// Claude Code hands every statusLine command a JSON document on stdin, and since
// 2.1.x it carries `rate_limits.five_hour` / `rate_limits.seven_day`
// (`used_percentage`, `resets_at`). That is the supported source: no token, no
// network, no undocumented endpoint. This installer registers a small script as
// the `statusLine` command in ~/.claude/settings.json. The script writes Aya's
// plain JSON snapshot (see electron/usage.ts) and then runs the user's previous
// statusLine command, if any, with the same input, so their status line keeps
// working. The Aya PROCESS only writes the script and reads the snapshot.
//
// Enabling is explicit (a Settings toggle with a disclosure dialog) and fully
// reversible - uninstall restores the previous statusLine and removes the script.
// Earlier builds used a Stop hook that called an undocumented endpoint; install
// and the launch-time refresh remove that hook.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { pathExists } from "./path-exists";
import { oneAtATime, withFileLock } from "./keyed-queue";
import { AYA_HOME, EXECUTABLE_FILE_MODE, USAGE_FILE } from "./paths";
import { listPresets } from "./presets";
import {
  CLAUDE_CONFIG_DIRNAME,
  CLAUDE_SETTINGS_FILENAME,
  DEFAULT_CLAUDE_CONFIG_DIR,
  expandUserPath,
} from "./usage";
import { shellQuote } from "./pane-command";

function hasSettingsOverride(): boolean {
  return !!process.env.AYA_CLAUDE_SETTINGS?.trim();
}

// Claude Code's global settings. AYA_CLAUDE_SETTINGS overrides it so tests can
// run the install/uninstall round-trip against a throwaway file instead of the
// real ~/.claude/settings.json.
const CLAUDE_SETTINGS_FILE =
  hasSettingsOverride()
    ? path.resolve(process.env.AYA_CLAUDE_SETTINGS!)
    : path.join(os.homedir(), CLAUDE_CONFIG_DIRNAME, CLAUDE_SETTINGS_FILENAME);
// The generated fetch script lives in Aya's own dir (always exists), referenced
// by absolute path from the hook entry.
export const HOOK_SCRIPT_FILE = path.join(AYA_HOME, "aya-usage-hook.sh");

// A status line redraws many times a turn; rewrite the snapshot at most this often.
export const HOOK_THROTTLE_SECONDS = 30;

export interface UsageHookStatus {
  installed: boolean;
  /** Absolute path to the generated script (whether or not it exists yet). */
  scriptPath: string;
  /** Where the hook is registered. */
  settingsPath: string;
}

/** The Stop-hook command earlier builds registered; only ever removed now. */
function legacyHookCommand(configDir: string): string {
  return `AYA_CLAUDE_CONFIG_DIR=${shellQuote(expandUserPath(configDir))} ${shellQuote(HOOK_SCRIPT_FILE)}`;
}

export async function claudeConfigDirs(): Promise<string[]> {
  if (hasSettingsOverride()) {
    return [path.dirname(CLAUDE_SETTINGS_FILE)];
  }
  const dirs = new Set<string>();
  try {
    for (const preset of await listPresets()) {
      if (preset.agent !== "claude") continue;
      dirs.add(expandUserPath(preset.configDir || DEFAULT_CLAUDE_CONFIG_DIR));
    }
  } catch {
    // fall through to default
  }
  if (dirs.size === 0) dirs.add(path.join(os.homedir(), CLAUDE_CONFIG_DIRNAME));
  return [...dirs];
}

export function settingsFileForConfigDir(configDir: string): string {
  if (hasSettingsOverride()) {
    return CLAUDE_SETTINGS_FILE;
  }
  return path.join(expandUserPath(configDir), CLAUDE_SETTINGS_FILENAME);
}

// ---- pure settings.json merge/unmerge (the risky part - unit-tested) --------

type StopEntry = { hooks?: Array<{ type?: string; command?: string }> };

/** True if settings already register a Stop hook whose command is `command`. */
export function hasStopHook(settings: unknown, command: string): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return false;
  const stop = (hooks as Record<string, unknown>).Stop;
  if (!Array.isArray(stop)) return false;
  return stop.some(
    (e: StopEntry) =>
      Array.isArray(e?.hooks) &&
      e.hooks.some((h) => h?.command === command),
  );
}

/** A NEW settings object without our Stop hook; emptied Stop / hooks containers go, other people's hooks
 *  stay. */
export function withoutStopHook(
  settings: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return settings;
  const h = hooks as Record<string, unknown>;
  if (!Array.isArray(h.Stop)) return settings;
  const stop = (h.Stop as StopEntry[]).filter(
    (e) => !(Array.isArray(e?.hooks) && e.hooks.some((x) => x?.command === command)),
  );
  const nextHooks: Record<string, unknown> = { ...h };
  if (stop.length > 0) nextHooks.Stop = stop;
  else delete nextHooks.Stop;
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

// ---- statusLine registration (pure, unit-tested) ---------------------------

type StatusLine = { type?: string; command?: string; padding?: number };

function statusLineOf(settings: unknown): StatusLine | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const sl = (settings as Record<string, unknown>).statusLine;
  return typeof sl === "object" && sl !== null && !Array.isArray(sl) ? (sl as StatusLine) : undefined;
}

/** True if this statusLine is the one Aya registered. */
export function isOurStatusLine(sl: unknown): boolean {
  const c = (sl as StatusLine | undefined)?.command;
  return typeof c === "string" && (c.includes(shellQuote(HOOK_SCRIPT_FILE)) || c.includes(HOOK_SCRIPT_FILE));
}

/** The user's statusLine command that our command wraps, if any. */
export function wrappedStatusLineCommand(sl: unknown): string | undefined {
  const c = (sl as StatusLine | undefined)?.command;
  const m = typeof c === "string" ? /AYA_STATUSLINE_NEXT_B64=([A-Za-z0-9+/=]*)/.exec(c) : null;
  return m?.[1] ? Buffer.from(m[1], "base64").toString("utf8") : undefined;
}

export function statusLineCommand(configDir: string, next?: string): string {
  const parts = [`AYA_CLAUDE_CONFIG_DIR=${shellQuote(expandUserPath(configDir))}`];
  if (next) parts.push(`AYA_STATUSLINE_NEXT_B64=${Buffer.from(next, "utf8").toString("base64")}`);
  parts.push(shellQuote(HOOK_SCRIPT_FILE));
  return parts.join(" ");
}

/** True if settings register our statusLine for exactly this config dir. */
export function hasStatusLine(settings: unknown, configDir: string): boolean {
  const sl = statusLineOf(settings);
  return isOurStatusLine(sl) && sl?.command?.includes(shellQuote(expandUserPath(configDir))) === true;
}

/** A NEW settings object whose statusLine runs our script, wrapping the user's
 *  own command (kept, so it still renders). A statusLine that is not a command
 *  is left alone: there is nothing we could wrap. */
export function withStatusLine(settings: Record<string, unknown>, configDir: string): Record<string, unknown> {
  const sl = statusLineOf(settings);
  let next: string | undefined;
  let rest: StatusLine = {};
  if (sl) {
    if (isOurStatusLine(sl)) {
      next = wrappedStatusLineCommand(sl);
      rest = { padding: sl.padding };
    } else if (sl.type === "command" && typeof sl.command === "string" && sl.command.trim()) {
      next = sl.command;
      rest = { padding: sl.padding };
    } else return settings;
  }
  const out: StatusLine = { type: "command", command: statusLineCommand(configDir, next) };
  if (typeof rest.padding === "number") out.padding = rest.padding;
  return { ...settings, statusLine: out };
}

/** A NEW settings object with the user's own statusLine back (or none, if they had none). */
export function withoutStatusLine(settings: Record<string, unknown>): Record<string, unknown> {
  const sl = statusLineOf(settings);
  if (!sl || !isOurStatusLine(sl)) return settings;
  const next = wrappedStatusLineCommand(sl);
  const out: Record<string, unknown> = { ...settings };
  if (next) {
    out.statusLine = { type: "command", command: next, ...(typeof sl.padding === "number" ? { padding: sl.padding } : {}) };
  } else delete out.statusLine;
  return out;
}

// ---- the generated script ---------------------------------------------------

// The default Claude dir as the generated shell script spells it.
const SH_HOME_CLAUDE_DIR = `$HOME/${CLAUDE_CONFIG_DIRNAME}`;

/** Reads Claude Code's statusLine JSON on stdin, snapshots `rate_limits` in Aya's file shape (throttled), then
 *  runs the user's previous statusLine command on the same input. Never fails the status line. */
export function hookScriptSource(outFile: string): string {
  return `#!/usr/bin/env bash
# Auto-generated by Aya (Settings -> usage chip). Claude Code's statusLine command:
# saves the account-wide rate limits it reports to Aya's usage snapshot, then runs
# your previous statusLine command (if any) with the same input. No token, no
# network. Remove it from Aya Settings.
OUT=${JSON.stringify(outFile)}
INPUT=$(cat)
snapshot() {
  command -v jq >/dev/null 2>&1 || return 0
  CONFIG_DIR="\${AYA_CLAUDE_CONFIG_DIR:-\${CLAUDE_CONFIG_DIR:-${SH_HOME_CLAUDE_DIR}}}"
  mkdir -p "$(dirname "$OUT")" || return 0
  if command -v shasum >/dev/null 2>&1; then
    HASH=$(printf '%s' "$CONFIG_DIR" | shasum -a 256 | awk '{print $1}')
  else
    HASH=$(printf '%s' "$CONFIG_DIR" | sha256sum | awk '{print $1}')
  fi
  ACCOUNT_OUT="$(dirname "$OUT")/usage-claude-$HASH.json"
  if [ -f "$ACCOUNT_OUT" ]; then
    now=$(date +%s)
    # GNU stat must come first. With coreutils, "stat -f %m" reads %m as a FILENAME,
    # prints a filesystem dump to stdout and only THEN fails, so the fallback appends
    # the real mtime to that dump and mod stops being a number. BSD stat has no -c,
    # so it falls through.
    mod=$(stat -c %Y "$ACCOUNT_OUT" 2>/dev/null || stat -f %m "$ACCOUNT_OUT" 2>/dev/null || true)
    case "$mod" in ''|*[!0-9]*) mod=0 ;; esac
    [ $((now - mod)) -lt ${HOOK_THROTTLE_SECONDS} ] && return 0
  fi
  SNAP=$(printf '%s' "$INPUT" | jq -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    def at: if type == "number" then ((if . > 100000000000 then . / 1000 else . end) | floor | todate) else tostring end;
    def win: if (.used_percentage | type) == "number"
      then {pct: .used_percentage} + (if .resets_at == null then {} else {resetsAt: (.resets_at | at)} end)
      else null end;
    (.rate_limits // {}) as $r
    | (if $r.five_hour == null then null else ($r.five_hour | win) end) as $f
    | (if $r.seven_day == null then null else ($r.seven_day | win) end) as $s
    | if $f == null and $s == null then empty
      else (if $f == null then {} else {fiveHour: $f} end) + (if $s == null then {} else {sevenDay: $s} end) + {updatedAt: $ts} end
  ' 2>/dev/null) || return 0
  [ -n "$SNAP" ] || return 0
  # One scratch file per process: status lines of several panes can run together.
  TMP="$ACCOUNT_OUT.$$.tmp"
  TMP_OUT="$OUT.$$.tmp"
  trap 'rm -f "$TMP" "$TMP_OUT"' RETURN
  printf '%s\\n' "$SNAP" > "$TMP" || return 0
  if [ "$CONFIG_DIR" = "${SH_HOME_CLAUDE_DIR}" ]; then
    printf '%s\\n' "$SNAP" > "$TMP_OUT" || return 0
    mv "$TMP_OUT" "$OUT"
  fi
  mv "$TMP" "$ACCOUNT_OUT"
}
snapshot >/dev/null 2>&1 || true
if [ -n "\${AYA_STATUSLINE_NEXT_B64:-}" ]; then
  NEXT=$(printf '%s' "$AYA_STATUSLINE_NEXT_B64" | base64 --decode 2>/dev/null) || exit 0
  printf '%s' "$INPUT" | sh -c "$NEXT"
fi
`;
}

// ---- fs-bound install / uninstall / status ----------------------------------

export async function readSettingsFile(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.json is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err; // malformed existing file - refuse to clobber it
  }
}

// Every edit of a Claude settings file goes through this queue, or two at once drop each other's hooks; the lock file
// orders another Aya process's edits too (Aya Dev, same HOME).
const oneEditAtATime = oneAtATime();
const SETTINGS_LOCK = `${CLAUDE_SETTINGS_FILE}.aya-lock`;
export const serially = <T>(edit: () => Promise<T>): Promise<T> =>
  oneEditAtATime("settings", () => withFileLock(SETTINGS_LOCK, edit));

export async function usageHookStatus(): Promise<UsageHookStatus> {
  let registered = true;
  const dirs = await claudeConfigDirs();
  for (const dir of dirs) {
    try {
      registered &&= hasStatusLine(await readSettingsFile(settingsFileForConfigDir(dir)), dir);
    } catch {
      registered = false;
    }
  }
  const scriptExists = await pathExists(HOOK_SCRIPT_FILE);
  return {
    installed: registered && scriptExists,
    scriptPath: HOOK_SCRIPT_FILE,
    settingsPath: dirs.map(settingsFileForConfigDir).join(", "),
  };
}

/** Earlier builds registered a Stop hook that called an undocumented endpoint. */
function withoutLegacyStopHook(settings: Record<string, unknown>, dir: string): Record<string, unknown> {
  return withoutStopHook(withoutStopHook(settings, HOOK_SCRIPT_FILE), legacyHookCommand(dir));
}

async function install(): Promise<UsageHookStatus> {
  for (const dir of await claudeConfigDirs()) {
    const settingsPath = settingsFileForConfigDir(dir);
    const settings = await readSettingsFile(settingsPath);
    const next = withStatusLine(withoutLegacyStopHook(settings, dir), dir);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + "\n");
  }
  await writeFileAtomic(HOOK_SCRIPT_FILE, hookScriptSource(USAGE_FILE));
  await fs.chmod(HOOK_SCRIPT_FILE, EXECUTABLE_FILE_MODE);
  return usageHookStatus();
}

async function uninstall(): Promise<UsageHookStatus> {
  for (const dir of await claudeConfigDirs()) {
    try {
      const settingsPath = settingsFileForConfigDir(dir);
      const settings = await readSettingsFile(settingsPath);
      const next = withoutStatusLine(withoutLegacyStopHook(settings, dir));
      await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + "\n");
    } catch {
      /* malformed/unreadable settings - leave it alone */
    }
  }
  await fs.rm(HOOK_SCRIPT_FILE, { force: true });
  return usageHookStatus();
}

async function hasLegacyStopHook(): Promise<boolean> {
  for (const dir of await claudeConfigDirs()) {
    try {
      const settings = await readSettingsFile(settingsFileForConfigDir(dir));
      if (hasStopHook(settings, legacyHookCommand(dir)) || hasStopHook(settings, HOOK_SCRIPT_FILE)) return true;
    } catch {
      /* unreadable settings: nothing to migrate there */
    }
  }
  return false;
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

/** At launch: an installed, out-of-date script is rewritten and a leftover endpoint Stop hook from an older build
 *  is replaced by the statusLine. Never installs for a user who had the chip off. */
export async function refreshUsageHookScript(): Promise<void> {
  if (await hasLegacyStopHook()) {
    await serially(install);
    return;
  }
  await refreshInstalledScript(HOOK_SCRIPT_FILE, hookScriptSource(USAGE_FILE));
}

export const installUsageHook = (): Promise<UsageHookStatus> => serially(install);
export const uninstallUsageHook = (): Promise<UsageHookStatus> => serially(uninstall);
