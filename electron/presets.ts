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

/** Agent CLIs Aya knows how to classify and resume. "custom" is anything
 *  else — a plain shell, a script, an agent we have no resume story for.
 *  Mirrored in src/types.ts; keep the two in sync. */
export type AgentKind =
  | "claude"
  | "codex"
  | "opencode"
  | "kilo"
  | "pi"
  | "cursor"
  | "copilot"
  | "grok"
  | "droid"
  | "devin"
  | "kimi"
  | "hermes"
  | "qodercli"
  | "antigravity"
  | "custom";

export interface Preset {
  id: string;
  name: string;
  icon: string;
  color: string; // CSS hex like "#d97757" or "" for the default neutral
  command: string;
  agent?: AgentKind;
  configDir?: string;
  unsafeMode?: boolean;
  autoResume?: boolean;
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

const AGENT_KINDS: readonly AgentKind[] = [
  "claude",
  "codex",
  "opencode",
  "kilo",
  "pi",
  "cursor",
  "copilot",
  "grok",
  "droid",
  "devin",
  "kimi",
  "hermes",
  "qodercli",
  "antigravity",
  "custom",
];

export function isAgentKind(x: unknown): x is AgentKind {
  return typeof x === "string" && (AGENT_KINDS as readonly string[]).includes(x);
}

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
  if (r.agent !== undefined && !isAgentKind(r.agent)) {
    return false;
  }
  if (r.configDir !== undefined && typeof r.configDir !== "string") {
    return false;
  }
  if (r.unsafeMode !== undefined && typeof r.unsafeMode !== "boolean") {
    return false;
  }
  if (r.autoResume !== undefined && typeof r.autoResume !== "boolean") {
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
  const agent = isAgentKind(raw.agent) ? raw.agent : undefined;
  const configDir =
    typeof raw.configDir === "string" && raw.configDir.trim()
      ? raw.configDir
      : undefined;
  return {
    id: raw.id,
    name: raw.name,
    icon: raw.icon,
    color: raw.color,
    command: raw.command,
    ...(agent ? { agent } : {}),
    ...(configDir ? { configDir } : {}),
    ...(raw.unsafeMode ? { unsafeMode: true } : {}),
    // Preserve an explicit autoResume:false (deliberate opt-out); absence is
    // treated as "default on" for agent presets by the renderer.
    ...(typeof raw.autoResume === "boolean" ? { autoResume: raw.autoResume } : {}),
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

// Parsed presets keyed by the file's mtime. Both usage handlers call
// listPresets on every 30s poll, so steady state should cost one stat instead
// of a read+parse. Gating on mtime (rather than invalidating in savePresets)
// also picks up hand-edits to presets.json.
let presetsCache: { mtimeMs: number; presets: Preset[] } | null = null;

/** Test hook: forget the cached presets.json parse. */
export function resetPresetsCache(): void {
  presetsCache = null;
}

export async function listPresets(): Promise<Preset[]> {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await fs.stat(PRESETS_FILE)).mtimeMs;
  } catch {
    // Missing/unreadable — fall through so the read path below handles it
    // (ENOENT seeds the first-launch presets).
    presetsCache = null;
  }
  if (mtimeMs !== null && presetsCache?.mtimeMs === mtimeMs) {
    // Copy so a caller mutating the array can't poison later polls.
    return [...presetsCache.presets];
  }
  try {
    const raw = await fs.readFile(PRESETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    const ok = Array.isArray(data?.presets) ? data.presets.filter(isPreset) : [];
    const presets: Preset[] = ok.length > 0 ? ok : [...DEFAULT_PRESETS];
    if (mtimeMs !== null) presetsCache = { mtimeMs, presets };
    return [...presets];
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
  // The new mtime would invalidate the cache anyway, but dropping it here
  // guards against sub-millisecond mtime collisions on rapid saves.
  presetsCache = null;
}
