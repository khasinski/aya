// Whether a preset's command would start: the pane spawn's own check, shared
// with `aya presets` and the Teams window so they call the same CLIs installed.
// PATH is checked on disk first: a login shell per name timed out under load (and spawn-gating
// security software blocks it), so the shell is asked once, only for the names PATH did not find.

import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs, statSync } from "node:fs";
import * as path from "node:path";
import { COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import type { Preset } from "./presets";
import { userShell } from "./shell";

type ProbeAnswer = "found" | "missing" | "no answer";

/** Strict allow-list for names put into the login shell's `command -v` script. */
export function isSafeBinaryName(s: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(s);
}

/** The command's binary, or null when it is not a plain `binary args` line
 *  (env prefixes, $SHELL, pipes): those start without a probe. */
export function preflightBinary(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (
    /(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) ||
    /[|&;<>(){}[\]*?~$`"'\\]/.test(trimmed)
  ) {
    return null;
  }
  const [binary] = trimmed.split(/\s+/);
  return isSafeBinaryName(binary) ? binary : null;
}

let pathRepaired = false;

/** Set once at startup: whether repairProcessPath got the login shell's PATH. */
export function notePathRepaired(repaired: boolean): void {
  pathRepaired = repaired;
}

async function onPath(binary: string): Promise<boolean> {
  // An empty, "." or relative entry means the pane's dir to its shell, not Aya's own cwd.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const file = path.join(dir, binary);
    try {
      if ((await fs.stat(file)).isFile()) {
        await fs.access(file, fsConstants.X_OK);
        return true;
      }
    } catch {}
  }
  return false;
}

const FOUND_MARK = "__AYA_FOUND__";

/** One login shell, in `cwd` when given, answers for every name; names it had not answered
 *  when the timeout killed it are "no answer". The script is POSIX and fish alike. */
function askLoginShell(binaries: readonly string[], cwd?: string): Promise<Map<string, ProbeAnswer>> {
  const script = binaries.map((b) => `command -v -- ${b} >/dev/null 2>&1 && echo ${FOUND_MARK}${b}`).join("; ");
  return new Promise((resolve) => {
    execFile(
      userShell(),
      ["-l", "-i", "-c", script],
      { cwd, timeout: COMMAND_PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (err, stdout) => {
        const found = new Set([...String(stdout).matchAll(new RegExp(`${FOUND_MARK}(\\S+)`, "g"))].map((m) => m[1]));
        const unfound: ProbeAnswer = err?.killed ? "no answer" : "missing";
        resolve(new Map(binaries.map((b) => [b, found.has(b) ? "found" : unfound])));
      },
    );
  });
}

/** Without `askShell`, a name not on PATH is missing. */
async function resolveCommands(binaries: readonly string[], askShell: boolean, cwd?: string): Promise<Map<string, ProbeAnswer>> {
  const safe = binaries.filter(isSafeBinaryName);
  const onPathNow = await Promise.all(safe.map(onPath));
  const misses = safe.filter((_, i) => !onPathNow[i]);
  const shell = askShell && misses.length ? await askLoginShell(misses, cwd) : new Map<string, ProbeAnswer>();
  return new Map(binaries.map((b) => [b, safe.includes(b) && !misses.includes(b) ? "found" : (shell.get(b) ?? "missing")]));
}

/** The harness scan: the login shell is asked only when PATH could not be repaired,
 *  so a CLI that exists only as a shell function or alias is not seeded then. */
export function scanCommands(binaries: readonly string[]): Promise<Map<string, ProbeAnswer>> {
  return resolveCommands(binaries, !pathRepaired);
}

// A found binary is cached for the process (sparing the shell for function launchers); misses and unanswered probes
// are not, so a tool installed mid-session is found by the next spawn.
const commandExistsCache = new Set<string>();

function existingDir(dir: string | undefined): string | undefined {
  try {
    return dir && statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Names asked in the same tick for one dir share one login shell: the preset list checks them all at once. */
const batches = new Map<string, { binaries: Set<string>; answers: Promise<Map<string, ProbeAnswer>> }>();

function askBatched(binary: string, dir: string | undefined): Promise<ProbeAnswer | undefined> {
  const key = dir ?? "";
  let batch = batches.get(key);
  if (!batch) {
    const binaries = new Set<string>();
    const answers = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      batches.delete(key);
      return resolveCommands([...binaries], true, dir);
    });
    batch = { binaries, answers };
    batches.set(key, batch);
  }
  batch.binaries.add(binary);
  return batch.answers.then((answers) => answers.get(binary));
}

/** False only when neither PATH nor the login shell, run in the pane's `cwd`, knows `binary`. The shell is asked even on
 *  a repaired PATH: zsh's `exec` runs a launcher defined as a function. */
export async function commandExists(binary: string, cwd?: string): Promise<boolean> {
  const dir = existingDir(cwd);
  const key = `${binary}\0${dir ?? ""}`;
  if (commandExistsCache.has(key)) return true;
  const answer = await askBatched(binary, dir);
  if (answer === "found") commandExistsCache.add(key);
  // A shell that did not answer in time is no proof the CLI is missing; the pane's own shell says so if it is.
  return answer !== "missing";
}

/** False only where a spawn would fail with "command not found". */
export async function presetInstalled(preset: Pick<Preset, "command">): Promise<boolean> {
  const binary = preflightBinary(preset.command);
  return binary === null || (await commandExists(binary));
}
