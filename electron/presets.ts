// Terminal presets (Claude / Codex / Shell / user-defined).
//
// Stored at ~/.aya/presets.json. On first launch we seed the file with the
// shipped DEFAULT_PRESETS. The user can edit, add, delete, or reset.
//
// IMPORTANT: the DEFAULT_PRESETS must never include flags that put claude or
// codex into non-interactive mode (-p, --print, --headless, etc.). Tests
// enforce this. Custom user presets are free to do whatever — that's user
// configuration, not something we control.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { scanHarnesses } from "./harnesses";
import { PRESETS_FILE } from "./paths";

export interface Preset {
  id: string;
  name: string;
  icon: string;
  color: string; // CSS hex like "#d97757" or "" for the default neutral
  command: string;
  /** Optional override. If set, terminals spawned from this preset render
   *  with the matching theme instead of the global active theme. Empty
   *  string and undefined both mean "use the default". */
  themeId?: string;
}

export const DEFAULT_PRESETS: readonly Preset[] = [
  {
    id: "shell",
    name: "Shell",
    icon: "$",
    color: "",
    // The literal $SHELL — the PTY wrapper expands this to the user's shell.
    command: "$SHELL",
  },
  {
    id: "claude",
    name: "Claude Code",
    icon: "✻",
    color: "#d97757",
    // INTERACTIVE — no -p / --print / --headless. Subscription license depends
    // on this.
    command: "claude",
  },
  {
    id: "codex",
    name: "Codex",
    icon: "◆",
    color: "#10a37f",
    command: "codex",
  },
];

export function isPreset(x: unknown): x is Preset {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.name !== "string" ||
    typeof r.icon !== "string" ||
    typeof r.color !== "string" ||
    typeof r.command !== "string"
  ) {
    return false;
  }
  // themeId is optional; if present must be a string.
  if (r.themeId !== undefined && typeof r.themeId !== "string") {
    return false;
  }
  return true;
}

/** Normalize a raw preset coming off disk. Drops bad shapes and ensures
 *  themeId is either a non-empty string or absent (never empty string). */
export function normalizePreset(raw: unknown): Preset | null {
  if (!isPreset(raw)) return null;
  const themeId =
    typeof raw.themeId === "string" && raw.themeId ? raw.themeId : undefined;
  return {
    id: raw.id,
    name: raw.name,
    icon: raw.icon,
    color: raw.color,
    command: raw.command,
    ...(themeId ? { themeId } : {}),
  };
}

/** Always-present shell preset. Added on first launch alongside any
 *  detected harnesses, and recoverable via BUILTIN_SHELL in the renderer
 *  if the user deletes it later. */
const SHELL_PRESET: Preset = {
  id: "shell",
  name: "Shell",
  icon: "$",
  color: "",
  command: "$SHELL",
};

export async function listPresets(): Promise<Preset[]> {
  try {
    const raw = await fs.readFile(PRESETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.presets)) return [...DEFAULT_PRESETS];
    const ok = data.presets.filter(isPreset);
    return ok.length > 0 ? ok : [...DEFAULT_PRESETS];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // First launch — scan PATH for installed harnesses and seed only
      // those, plus the shell fallback. User can add more later in
      // Settings via the "Suggested" section.
      const found = await scanHarnesses();
      const seeded: Preset[] = [
        ...found.map((h) => ({
          id: h.id,
          name: h.name,
          icon: h.icon,
          color: h.color,
          command: h.command,
        })),
        SHELL_PRESET,
      ];
      await savePresets(seeded);
      return seeded;
    }
    throw err;
  }
}

export async function savePresets(presets: Preset[]): Promise<void> {
  // Drop anything that doesn't look like a preset rather than silently
  // saving garbage.
  const sanitized = presets.filter(isPreset);
  await writeFileAtomic(
    PRESETS_FILE,
    JSON.stringify({ presets: sanitized }, null, 2) + "\n",
  );
}
