import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { PROJECT_AYA_DIRNAME } from "./paths";
import { normalizePreset, type Preset } from "./presets";

export interface RepoProjectConfig {
  presets: Preset[];
}

// project.json comes from a cloned repository, so it is read as untrusted: a few launchers fit in far less.
const MAX_PROJECT_JSON_BYTES = 256 * 1024;
// Text the import dialog shows on one line: a newline, an escape or a bidi control would hide part of a command.
const HIDDEN_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/** Only what the import dialog shows (icon, name, command) and what follows from it. Settings the user
 *  cannot see there, such as unsafeMode or another account's configDir, never come from a repo. */
function suggestion(raw: unknown): Preset | null {
  const preset = normalizePreset(raw);
  if (!preset || [preset.name, preset.icon, preset.command].some((text) => HIDDEN_TEXT.test(text))) return null;
  const { id, name, icon, color, command, agent, themeId } = preset;
  return { id, name, icon, color, command, ...(agent ? { agent } : {}), ...(themeId ? { themeId } : {}) };
}

export async function readRepoProjectConfig(
  directory: string,
): Promise<RepoProjectConfig | null> {
  const ayaDir = path.join(directory, PROJECT_AYA_DIRNAME);
  let raw: string;
  try {
    // A real directory and a regular file inside the repo: never a link out of it, a FIFO or a device.
    if (!(await fs.lstat(ayaDir)).isDirectory()) return null;
    const handle = await fs.open(path.join(ayaDir, "project.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return null;
      // One byte past the cap, whatever the size said: a file growing while it is read stays bounded.
      const buffer = Buffer.alloc(MAX_PROJECT_JSON_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PROJECT_JSON_BYTES) return null;
      raw = buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    // Missing, unreadable, or something else in its place (a file named .aya, a symlinked project.json):
    // a suggestion is never worth an error.
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = (data as { presets?: unknown } | null)?.presets;
  const presets = Array.isArray(list)
    ? list.map(suggestion).filter((preset): preset is Preset => preset !== null)
    : [];
  if (presets.length === 0) return null;
  return { presets };
}
