// Codex half of AUTOMATIC agent status (#38), the follow-up to the Claude Code
// installer in electron/status-hook.ts.
//
// Codex has no per-event hook array like Claude's settings.json. Its stable
// surface is the `notify` program in ~/.codex/config.toml: a SINGLE external
// command Codex runs on a notification, passing the event as a JSON string in
// the LAST argv. Today the only event is `agent-turn-complete`, so Codex can
// report exactly one transition:
//   agent-turn-complete -> done   (turn finished)
//
// Because `notify` is singular (not an array we can add one entry to), we must
// never clobber a user's own notify program: we install ours ONLY when there is
// no top-level notify, and on removal we drop ONLY a notify line that points at
// our script. Same trust boundary as the Claude script: the program no-ops
// entirely outside an Aya terminal (AYA_SOCKET / AYA_TERMINAL_ID unset).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AYA_HOME } from "./paths";
import { bundledAyaCliPath } from "./cli-path";
import { DEFAULT_CODEX_HOME } from "./usage-codex";

/** The generated notify program, in Aya's own dir (always exists). */
export const STATUS_HOOK_CODEX_SCRIPT_FILE = path.join(
  AYA_HOME,
  "aya-status-codex-notify.sh",
);
// Executable mode for the generated script (rwxr-xr-x).
const HOOK_SCRIPT_MODE = 0o755;

/** Codex's config file — the one that carries `notify`. */
export function codexConfigPath(): string {
  return path.join(DEFAULT_CODEX_HOME, "config.toml");
}

export interface CodexStatusHookStatus {
  /** Our notify program is the one configured. */
  configured: boolean;
  /** A DIFFERENT notify program is already set; we left it untouched. */
  conflict: boolean;
  scriptPath: string;
  configPath: string;
}

// ---- pure config.toml notify merge/unmerge (the risky part — unit-tested) ---
//
// We deliberately do NOT parse/re-serialize the whole TOML (that would lose the
// user's comments and formatting). We only ever add a single top-level line or
// remove our own, treating the value opaquely.

/** A TOML basic-string literal for a filesystem path. Paths under ~/.aya never
 *  contain quotes, but escape defensively so a weird home dir can't break the
 *  file. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The `notify = [...]` line we write. */
export function codexNotifyLine(scriptPath: string): string {
  return `notify = [${tomlString(scriptPath)}]`;
}

/** The first TOP-LEVEL `notify = ...` line, or null. "Top-level" means before
 *  the first `[table]` / `[[array]]` header — a `notify` under a table is that
 *  table's key, not Codex's global notify program. Returns the raw line so the
 *  caller can decide whether it is ours. */
export function findTopLevelNotify(toml: string): string | null {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    // A table header ends the top-level scope; stop looking.
    if (line.startsWith("[")) return null;
    if (/^notify\s*=/.test(line)) return raw;
  }
  return null;
}

/** True when the top-level notify (if any) already points at `scriptPath`. */
export function notifyIsOurs(toml: string, scriptPath: string): boolean {
  const line = findTopLevelNotify(toml);
  return line !== null && line.includes(scriptPath);
}

export interface CodexNotifyMerge {
  toml: string;
  /** We wrote our notify line (was absent). */
  installed: boolean;
  /** A different notify program is set; we changed nothing. */
  conflict: boolean;
}

/** Add our notify line when there is no top-level notify at all. Idempotent
 *  (ours already there -> installed). A different notify -> conflict, untouched.
 *  We prepend, since a bare key at the top of the file is unambiguously
 *  top-level whatever follows. */
export function withCodexNotify(
  toml: string,
  scriptPath: string,
): CodexNotifyMerge {
  const existing = findTopLevelNotify(toml);
  if (existing !== null) {
    return existing.includes(scriptPath)
      ? { toml, installed: true, conflict: false }
      : { toml, installed: false, conflict: true };
  }
  const line = codexNotifyLine(scriptPath);
  const next = toml.length === 0 ? `${line}\n` : `${line}\n${toml}`;
  return { toml: next, installed: true, conflict: false };
}

/** Remove ONLY a top-level notify line that points at our script; leave a
 *  user's own notify alone. */
export function withoutCodexNotify(toml: string, scriptPath: string): string {
  let sawHeader = false;
  const kept: string[] = [];
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) sawHeader = true;
    const isOurs =
      !sawHeader && /^notify\s*=/.test(line) && raw.includes(scriptPath);
    if (!isOurs) kept.push(raw);
  }
  return kept.join("\n");
}

// ---- the generated notify program -------------------------------------------

/** The notify program Codex runs. Codex passes the event JSON as the LAST argv
 *  ($1 here, since we register no extra args), maps `agent-turn-complete` to
 *  `aya status done`, and no-ops outside an Aya terminal. `ayaCli` is the
 *  fallback path to the bundled CLI when `aya` is not on PATH. */
export function codexNotifyScriptSource(ayaCli: string): string {
  return `#!/usr/bin/env bash
# Auto-generated by Aya (Settings -> automatic status). Reports Codex's
# turn state into the Aya pane it runs in, via \`aya status\`. Codex passes the
# notification JSON as the last argument; this no-ops entirely outside an Aya
# terminal (AYA_SOCKET / AYA_TERMINAL_ID unset), so it does nothing in Codex
# sessions run elsewhere. Remove it from Aya Settings.
set -euo pipefail
[ -n "\${AYA_SOCKET:-}" ] || exit 0
[ -n "\${AYA_TERMINAL_ID:-}" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
PAYLOAD="\${1:-}"
[ -n "$PAYLOAD" ] || exit 0
AYA=$(command -v aya 2>/dev/null || true)
[ -n "$AYA" ] || AYA=${JSON.stringify(ayaCli)}
[ -x "$AYA" ] || exit 0
TYPE=$(printf '%s' "$PAYLOAD" | jq -r '.type // empty')
case "$TYPE" in
  agent-turn-complete)
    "$AYA" status done "Turn finished" >/dev/null 2>&1 || true ;;
esac
exit 0
`;
}

// ---- fs-bound install / uninstall / status ----------------------------------

async function readConfigToml(): Promise<string> {
  try {
    return await fs.readFile(codexConfigPath(), "utf8");
  } catch {
    return "";
  }
}

export async function statusCodexHookStatus(): Promise<CodexStatusHookStatus> {
  const scriptPath = STATUS_HOOK_CODEX_SCRIPT_FILE;
  const configPath = codexConfigPath();
  const toml = await readConfigToml();
  const topNotify = findTopLevelNotify(toml);
  const ours = topNotify !== null && topNotify.includes(scriptPath);
  let scriptExists = false;
  try {
    await fs.access(scriptPath);
    scriptExists = true;
  } catch {
    scriptExists = false;
  }
  return {
    configured: ours && scriptExists,
    conflict: topNotify !== null && !ours,
    scriptPath,
    configPath,
  };
}

/** Install our notify program, unless the user already has their own notify
 *  (then we leave it and report conflict). Best-effort: a Codex home that
 *  doesn't exist yet is created so status still lights up once Codex runs. */
export async function installStatusCodexHook(): Promise<CodexStatusHookStatus> {
  const scriptPath = STATUS_HOOK_CODEX_SCRIPT_FILE;
  const configPath = codexConfigPath();
  const merge = withCodexNotify(await readConfigToml(), scriptPath);
  if (merge.installed) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, merge.toml);
    await writeFileAtomic(
      scriptPath,
      codexNotifyScriptSource(bundledAyaCliPath(__dirname)),
    );
    await fs.chmod(scriptPath, HOOK_SCRIPT_MODE);
  }
  return statusCodexHookStatus();
}

export async function uninstallStatusCodexHook(): Promise<CodexStatusHookStatus> {
  const scriptPath = STATUS_HOOK_CODEX_SCRIPT_FILE;
  const configPath = codexConfigPath();
  const toml = await readConfigToml();
  if (notifyIsOurs(toml, scriptPath)) {
    await writeFileAtomic(configPath, withoutCodexNotify(toml, scriptPath));
  }
  await fs.rm(scriptPath, { force: true });
  return statusCodexHookStatus();
}
