// Optional, user-enabled installer for the account-wide usage chip.
//
// IMPORTANT trust boundary: the Aya PROCESS never reads your auth token and
// never calls Anthropic. This installer only writes a shell script + a Claude
// Code "Stop" hook into ~/.claude/settings.json. The token read + the call to
// the (undocumented, unsupported) usage endpoint happen later, in that separate
// shell script, run by Claude Code — not in Aya. Aya only ever reads the plain
// JSON file the script writes (see electron/usage.ts).
//
// Enabling is explicit (a Settings toggle with a full-disclosure dialog) and
// fully reversible — uninstall removes the hook entry and the script.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AYA_HOME, USAGE_FILE } from "./paths";
import { listPresets } from "./presets";
import { expandUserPath } from "./usage";

// Claude Code's global settings. AYA_CLAUDE_SETTINGS overrides it so tests can
// run the install/uninstall round-trip against a throwaway file instead of the
// real ~/.claude/settings.json.
const CLAUDE_SETTINGS_FILE =
  process.env.AYA_CLAUDE_SETTINGS && process.env.AYA_CLAUDE_SETTINGS.trim()
    ? path.resolve(process.env.AYA_CLAUDE_SETTINGS)
    : path.join(os.homedir(), ".claude", "settings.json");
// The generated fetch script lives in Aya's own dir (always exists), referenced
// by absolute path from the hook entry.
export const HOOK_SCRIPT_FILE = path.join(AYA_HOME, "aya-usage-hook.sh");

// Generated-script tuning: skip a fetch if the file was written within the
// throttle window, and bound the network call so a hung endpoint can't stall.
const HOOK_THROTTLE_SECONDS = 300;
const HOOK_FETCH_TIMEOUT_SECONDS = 10;
// Executable mode for the generated fetch script (rwxr-xr-x).
const HOOK_SCRIPT_MODE = 0o755;

export interface UsageHookStatus {
  installed: boolean;
  /** Absolute path to the generated script (whether or not it exists yet). */
  scriptPath: string;
  /** Where the hook is registered. */
  settingsPath: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function hookCommand(configDir: string): string {
  return `AYA_CLAUDE_CONFIG_DIR=${shellQuote(expandUserPath(configDir))} ${shellQuote(HOOK_SCRIPT_FILE)}`;
}

async function claudeConfigDirs(): Promise<string[]> {
  if (process.env.AYA_CLAUDE_SETTINGS && process.env.AYA_CLAUDE_SETTINGS.trim()) {
    return [path.dirname(CLAUDE_SETTINGS_FILE)];
  }
  const dirs = new Set<string>();
  try {
    for (const preset of await listPresets()) {
      if (preset.agent !== "claude") continue;
      dirs.add(expandUserPath(preset.configDir || "~/.claude"));
    }
  } catch {
    // fall through to default
  }
  if (dirs.size === 0) dirs.add(path.join(os.homedir(), ".claude"));
  return [...dirs];
}

function settingsFileForConfigDir(configDir: string): string {
  if (process.env.AYA_CLAUDE_SETTINGS && process.env.AYA_CLAUDE_SETTINGS.trim()) {
    return CLAUDE_SETTINGS_FILE;
  }
  return path.join(expandUserPath(configDir), "settings.json");
}

// ---- pure settings.json merge/unmerge (the risky part — unit-tested) --------

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

/** Return a NEW settings object with our Stop hook added (idempotent), leaving
 *  every other key — and any other Stop hooks — untouched. */
export function withStopHook(
  settings: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  if (hasStopHook(settings, command)) return settings;
  const hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}) };
  const stop = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  stop.push({ hooks: [{ type: "command", command }] });
  return { ...settings, hooks: { ...hooks, Stop: stop } };
}

/** Return a NEW settings object with our Stop hook removed, leaving everything
 *  else intact. Drops now-empty Stop / hooks containers so we don't leave
 *  litter, but never touches other people's hooks. */
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

// ---- the generated fetch script ---------------------------------------------

/** The shell script the hook runs. Throttled; reads the token from the OS
 *  credential store; calls the usage endpoint; writes Aya's file shape. Exits
 *  quietly on any missing dependency or failure so it never breaks a session. */
export function hookScriptSource(outFile: string): string {
  return `#!/usr/bin/env bash
# Auto-generated by Aya (Settings -> usage chip). Writes the account-wide usage
# snapshot Aya reads. It calls Anthropic's UNDOCUMENTED usage endpoint with your
# OWN token — unsupported, may change. Remove it from Aya Settings.
set -euo pipefail
OUT=${JSON.stringify(outFile)}
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
CONFIG_DIR="\${AYA_CLAUDE_CONFIG_DIR:-\${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
mkdir -p "$(dirname "$OUT")"
if command -v shasum >/dev/null 2>&1; then
  HASH=$(printf '%s' "$CONFIG_DIR" | shasum -a 256 | awk '{print $1}')
else
  HASH=$(printf '%s' "$CONFIG_DIR" | sha256sum | awk '{print $1}')
fi
ACCOUNT_OUT="$(dirname "$OUT")/usage-claude-$HASH.json"
# Throttle per account: skip if this config dir was written in the last 5 minutes.
if [ -f "$ACCOUNT_OUT" ]; then
  now=$(date +%s)
  mod=$(stat -f %m "$ACCOUNT_OUT" 2>/dev/null || stat -c %Y "$ACCOUNT_OUT" 2>/dev/null || echo 0)
  [ $((now - mod)) -lt ${HOOK_THROTTLE_SECONDS} ] && exit 0
fi
# Claude Code OAuth token: macOS Keychain, else Linux credentials file.
if [ -f "$CONFIG_DIR/.credentials.json" ]; then
  RAW=$(cat "$CONFIG_DIR/.credentials.json")
elif RAW=$(security find-generic-password -s "Claude Code-credentials-\${HASH:0:8}" -w 2>/dev/null); then
  :
elif [ "$CONFIG_DIR" = "$HOME/.claude" ] && RAW=$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null); then
  :
elif [ -f "$HOME/.claude/.credentials.json" ]; then
  RAW=$(cat "$HOME/.claude/.credentials.json")
else
  exit 0
fi
TOKEN=$(printf '%s' "$RAW" | jq -r '.claudeAiOauth.accessToken // empty')
[ -n "$TOKEN" ] || exit 0
RESP=$(curl -sS -m ${HOOK_FETCH_TIMEOUT_SECONDS} -H "Authorization: Bearer $TOKEN" \\
  https://api.anthropic.com/api/oauth/usage) || exit 0
printf '%s' "$RESP" | jq \\
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
  '{fiveHour:{pct:.five_hour.utilization, resetsAt:.five_hour.resets_at},
    sevenDay:{pct:.seven_day.utilization, resetsAt:.seven_day.resets_at},
    updatedAt:$ts}' > "$ACCOUNT_OUT.tmp" && mv "$ACCOUNT_OUT.tmp" "$ACCOUNT_OUT"
if [ "$CONFIG_DIR" = "$HOME/.claude" ]; then
  cp "$ACCOUNT_OUT" "$OUT"
fi
`;
}

// ---- fs-bound install / uninstall / status ----------------------------------

async function readSettingsFile(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.json is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err; // malformed existing file — refuse to clobber it
  }
}

export async function usageHookStatus(): Promise<UsageHookStatus> {
  let registered = true;
  const dirs = await claudeConfigDirs();
  for (const dir of dirs) {
    try {
      const settingsPath = settingsFileForConfigDir(dir);
      const settings = await readSettingsFile(settingsPath);
      registered &&= hasStopHook(settings, hookCommand(dir)) || hasStopHook(settings, HOOK_SCRIPT_FILE);
    } catch {
      registered = false;
    }
  }
  let scriptExists = false;
  try {
    await fs.access(HOOK_SCRIPT_FILE);
    scriptExists = true;
  } catch {
    scriptExists = false;
  }
  return {
    installed: registered && scriptExists,
    scriptPath: HOOK_SCRIPT_FILE,
    settingsPath: dirs.map(settingsFileForConfigDir).join(", "),
  };
}

export async function installUsageHook(): Promise<UsageHookStatus> {
  for (const dir of await claudeConfigDirs()) {
    const settingsPath = settingsFileForConfigDir(dir);
    const settings = await readSettingsFile(settingsPath);
    const withoutLegacy = withoutStopHook(settings, HOOK_SCRIPT_FILE);
    const next = withStopHook(withoutLegacy, hookCommand(dir));
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + "\n");
  }
  await writeFileAtomic(HOOK_SCRIPT_FILE, hookScriptSource(USAGE_FILE));
  await fs.chmod(HOOK_SCRIPT_FILE, HOOK_SCRIPT_MODE);
  return usageHookStatus();
}

export async function uninstallUsageHook(): Promise<UsageHookStatus> {
  for (const dir of await claudeConfigDirs()) {
    try {
      const settingsPath = settingsFileForConfigDir(dir);
      const settings = await readSettingsFile(settingsPath);
      const next = withoutStopHook(
        withoutStopHook(settings, HOOK_SCRIPT_FILE),
        hookCommand(dir),
      );
      await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + "\n");
    } catch {
      /* malformed/unreadable settings — leave it alone */
    }
  }
  await fs.rm(HOOK_SCRIPT_FILE, { force: true });
  return usageHookStatus();
}
