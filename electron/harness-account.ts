// Derive which account (config dir) a preset launches, from its command.
//
// Aya shows per-account usage chips. A user runs a second Claude/Codex account
// via a shell wrapper that sets CLAUDE_CONFIG_DIR / CODEX_HOME, e.g.:
//   claude2 () { env … CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" claude "$@"; }
//   codex2  -> exec env CODEX_HOME="$HOME/.codex2" codex "$@"
// The config dir is hidden inside the wrapper, not the preset command, so we
// resolve the command's binary one level through the user's shell (read the
// function body / script text) and scan it for the relevant env assignment.
//
// Pure parsing (parseLaunch / scanWrapper) is unit-tested; resolveHarnessAccount
// is the thin shell-bound wrapper around them.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { isSafeBinaryName } from "./harnesses";
import { userShell } from "./shell";

export type HarnessKind = "claude" | "codex";

export interface HarnessAccount {
  harness: HarnessKind;
  /** Absolute config dir: CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex. */
  configDir: string;
}

const RESOLVE_TIMEOUT_MS = 4000;
// Reading config dir doesn't change between polls; resolving spawns a login
// shell, so cache by command string (preset edits change the string → re-resolve).
const cache = new Map<string, HarnessAccount | null>();

interface Launch {
  env: Record<string, string>;
  binary: string;
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** Strip a leading `exec`, an `env [-u NAME]… ` prefix, and `KEY=VAL`
 *  assignments from a command, returning the collected env + the first real
 *  token (the binary). Pure. */
export function parseLaunch(command: string): Launch {
  const tokens = tokenize(command);
  const env: Record<string, string> = {};
  let i = 0;
  if (tokens[i] === "exec") i++;
  if (tokens[i] === "env") {
    i++;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === "-u" || t === "--unset") {
        i += 2;
        continue;
      }
      if (t === "-i" || t === "-") {
        i++;
        continue;
      }
      break;
    }
  }
  while (i < tokens.length) {
    const eq = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tokens[i]);
    if (!eq) break;
    env[eq[1]] = stripQuotes(eq[2]);
    i++;
  }
  return { env, binary: tokens[i] ?? "" };
}

const CONFIG_KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME"] as const;

/** Scan a resolved wrapper definition (zsh function body or script text) for the
 *  config-dir env assignment and which harness binary it ultimately runs. Pure
 *  heuristic over the text — good enough for the common `env KEY=… claude` shape. */
export function scanWrapper(text: string): {
  env: Record<string, string>;
  harness: HarnessKind | null;
} {
  const env: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const re = new RegExp(`\\b${key}=(?:"([^"]*)"|'([^']*)'|(\\S+))`);
    const m = re.exec(text);
    if (m) env[key] = m[1] ?? m[2] ?? m[3] ?? "";
  }
  const harness: HarnessKind | null = /\bclaude\b/.test(text)
    ? "claude"
    : /\bcodex\b/.test(text)
      ? "codex"
      : null;
  return { env, harness };
}

function harnessFromBinary(binary: string): HarnessKind | null {
  const base = path.basename(binary);
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return null;
}

function expandPath(value: string, home: string): string {
  let v = value;
  if (v === "~" || v.startsWith("~/")) v = home + v.slice(1);
  v = v.replace(/\$\{HOME\}|\$HOME/g, home);
  return path.resolve(v);
}

function accountFrom(
  harness: HarnessKind,
  env: Record<string, string>,
): HarnessAccount {
  const home = env.HOME ? expandPath(env.HOME, os.homedir()) : os.homedir();
  const dirEnv = harness === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
  const fallback = path.join(home, harness === "claude" ? ".claude" : ".codex");
  return {
    harness,
    configDir: dirEnv ? expandPath(dirEnv, home) : fallback,
  };
}

function runShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      userShell(),
      ["-l", "-i", "-c", script],
      { timeout: RESOLVE_TIMEOUT_MS, windowsHide: true },
      (_err, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
    );
  });
}

const BINARY_HEAD_BYTES = 256;

/** Resolve a wrapper binary to readable text: a zsh/bash function body, or the
 *  contents of a wrapper script. Returns null for a real (binary) executable or
 *  if nothing resolves. */
async function resolveDefinition(binary: string): Promise<string | null> {
  const out = (
    await runShell(
      `whence -f ${binary} 2>/dev/null || type ${binary} 2>/dev/null || command -v -- ${binary} 2>/dev/null`,
    )
  ).trim();
  if (!out) return null;
  if (/\(\)\s*\{/.test(out)) return out; // function body
  if (out.startsWith("/")) {
    try {
      const buf = await fs.readFile(out);
      // Skip Mach-O / ELF binaries (NUL in the head is a reliable tell).
      if (buf.subarray(0, BINARY_HEAD_BYTES).includes(0)) return null;
      return buf.toString("utf-8");
    } catch {
      return null;
    }
  }
  return out; // alias description etc.
}

/** Determine the account (harness + absolute config dir) a preset command
 *  launches, or null for non-agent presets. Resolves wrappers one level. */
export async function resolveHarnessAccount(
  command: string,
): Promise<HarnessAccount | null> {
  if (cache.has(command)) return cache.get(command) ?? null;
  const result = await resolveUncached(command);
  cache.set(command, result);
  return result;
}

async function resolveUncached(command: string): Promise<HarnessAccount | null> {
  const { env, binary } = parseLaunch(command);
  if (!binary) return null;

  const direct = harnessFromBinary(binary);
  if (direct) return accountFrom(direct, env);

  // A wrapper (function/script) — resolve one level and scan its definition.
  if (!isSafeBinaryName(binary)) return null;
  const def = await resolveDefinition(binary);
  if (!def) return null;
  const scanned = scanWrapper(def);
  if (!scanned.harness) return null;
  // Outer preset env (if any) overrides the wrapper's.
  return accountFrom(scanned.harness, { ...scanned.env, ...env });
}

/** Resolve all accounts of a given harness from a preset list, deduped by
 *  config dir. Each entry keeps a stable id (preset id) + label (preset name). */
export async function resolveHarnessAccounts(
  presets: Array<{ id: string; name: string; command: string }>,
  harness: HarnessKind,
): Promise<Array<{ id: string; label: string; configDir: string }>> {
  const byDir = new Map<string, { id: string; label: string; configDir: string }>();
  for (const p of presets) {
    const acc = await resolveHarnessAccount(p.command);
    if (!acc || acc.harness !== harness) continue;
    if (!byDir.has(acc.configDir)) {
      byDir.set(acc.configDir, {
        id: p.id,
        label: p.name,
        configDir: acc.configDir,
      });
    }
  }
  return [...byDir.values()];
}
