// Whether a preset's command would start: the pane spawn's own check, shared
// with `aya presets` and the Teams window so they call the same CLIs installed.

import { execFile } from "node:child_process";
import { COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import type { Preset } from "./presets";
import { userShell } from "./shell";

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
  return /^[a-zA-Z0-9_.-]+$/.test(binary) ? binary : null;
}

// The probe spawns a full login+interactive shell (oh-my-zsh startup can be
// hundreds of ms), and it runs before EVERY non-shell spawn for the same few
// binaries. A found binary effectively never disappears mid-session, so cache
// positives for the process lifetime; misses stay uncached so installing a
// tool mid-session is picked up by the next spawn.
const commandExistsCache = new Set<string>();

export async function commandExists(binary: string): Promise<boolean> {
  if (commandExistsCache.has(binary)) return true;
  const found = await new Promise<boolean>((resolve) => {
    execFile(
      userShell(),
      ["-l", "-i", "-c", `command -v -- ${binary} >/dev/null 2>&1`],
      { timeout: COMMAND_PROBE_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(err === null),
    );
  });
  if (found) commandExistsCache.add(binary);
  return found;
}

/** False only where a spawn would fail with "command not found". */
export async function presetInstalled(preset: Pick<Preset, "command">): Promise<boolean> {
  const binary = preflightBinary(preset.command);
  return binary === null || (await commandExists(binary));
}
