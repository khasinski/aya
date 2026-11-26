// Before a pane could switch between its terminal and its Conversation, the Conversation was a separate preset, so
// users kept twins such as "Claude" and "Claude GUI". A preset now only says how a new pane opens. This merges each
// twin pair into the terminal preset: panes of the removed Conversation preset point at the kept one and keep
// opening as a Conversation. Only exact launch twins merge; any other preset stays as the user made it.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { PRESETS_FILE, PROJECTS_DIR } from "./paths";
import { isPreset, type Preset } from "./presets";

const GUI_AGENTS = new Set(["claude", "codex", "pi", "antigravity"]);
const PROGRAM_AGENT: Record<string, string> = { claude: "claude", codex: "codex", pi: "pi", agy: "antigravity" };

/** The preset's agent as the renderer's guiSupportedAgent sees it: the explicit field, else the command's binary
 *  (an account preset's CLAUDE_CONFIG_DIR / CODEX_HOME prefix names it too). "custom" for any other program. */
function agentOf(p: Preset): string {
  if (p.agent && p.agent !== "custom") return p.agent;
  const command = p.command.trim();
  if (/\bCLAUDE_CONFIG_DIR=/.test(command)) return "claude";
  if (/\bCODEX_HOME=/.test(command)) return "codex";
  const program = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:exec\s+)?(?:\S*\/)?(\S+)/.exec(command)?.[1];
  return (program && PROGRAM_AGENT[program]) || "custom";
}

/** A preset of an agent without a Conversation GUI never opened as one, so it is never merged. */
const hasGui = (p: Preset) => GUI_AGENTS.has(agentOf(p));

/** Same CLI, same account, same flags: everything that changes what a pane runs, but not how it looks or opens. */
function launchKey(p: Preset): string {
  return JSON.stringify([
    p.command.trim().replace(/\s+/g, " "),
    agentOf(p),
    p.configDir?.trim() || null,
    p.unsafeMode === true,
    p.autoResume ?? null,
    p.agentBrief === true,
  ]);
}

export interface PresetMerge {
  presets: Preset[];
  /** Removed preset id → the preset its panes use now. Empty when nothing merged. */
  remap: Record<string, string>;
}

/** Merge each Conversation preset into the terminal preset it duplicates. The first terminal preset with the same
 *  launch wins, keeping its id, name, look and "Opens as" Terminal; a Conversation preset with no terminal twin
 *  stays (as a preset that opens as a Conversation). Running it again changes nothing. */
export function mergeInterfaceTwins(presets: readonly Preset[]): PresetMerge {
  const terminalByKey = new Map<string, Preset>();
  for (const p of presets) {
    if (p.interfaceMode !== "gui" && hasGui(p) && !terminalByKey.has(launchKey(p))) terminalByKey.set(launchKey(p), p);
  }
  const remap: Record<string, string> = {};
  const kept: Preset[] = [];
  for (const p of presets) {
    const twin = p.interfaceMode === "gui" && hasGui(p) ? terminalByKey.get(launchKey(p)) : undefined;
    if (twin && twin.id !== p.id) remap[p.id] = twin.id;
    else kept.push(p);
  }
  return { presets: Object.keys(remap).length ? kept : [...presets], remap };
}

/** A project file's tabs with merged presets remapped. A tab of a removed Conversation preset was a Conversation
 *  pane, so it keeps that mode explicitly. Null when nothing changed. */
export function remapProjectTabs(project: Record<string, unknown>, remap: Readonly<Record<string, string>>): Record<string, unknown> | null {
  if (!Array.isArray(project.tabs)) return null;
  let changed = false;
  const tabs = project.tabs.map((tab: unknown) => {
    if (!tab || typeof tab !== "object") return tab;
    const t = tab as Record<string, unknown>;
    const target = typeof t.presetId === "string" ? remap[t.presetId] : undefined;
    if (!target) return tab;
    changed = true;
    return { ...t, presetId: target, interfaceMode: t.interfaceMode === "terminal" || t.interfaceMode === "gui" ? t.interfaceMode : "gui" };
  });
  return changed ? { ...project, tabs } : null;
}

let startupMerge: Record<string, string> = {};
/** What this start's migration merged (removed preset id → kept id), for the renderer's per-preset settings. */
export const startupPresetMerges = (): Record<string, string> => ({ ...startupMerge });

/** Run at startup, before any window loads presets or projects. Projects are rewritten first: if Aya stops halfway,
 *  the twins are still there and the next start finishes, and no tab ever names a preset that is gone. */
export async function migrateInterfaceTwinPresets(
  presetsFile: string = PRESETS_FILE,
  projectsDir: string = PROJECTS_DIR,
): Promise<PresetMerge> {
  let raw: string;
  try { raw = await fs.readFile(presetsFile, "utf-8"); }
  catch { return { presets: [], remap: {} }; }
  let data: { presets?: unknown };
  try { data = JSON.parse(raw) as { presets?: unknown }; } catch { return { presets: [], remap: {} }; }
  if (!Array.isArray(data.presets)) return { presets: [], remap: {} };
  const merge = mergeInterfaceTwins(data.presets.filter(isPreset));
  if (!Object.keys(merge.remap).length) return merge;
  for (const file of (await fs.readdir(projectsDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))) {
    const full = path.join(projectsDir, file);
    try {
      const next = remapProjectTabs(JSON.parse(await fs.readFile(full, "utf-8")) as Record<string, unknown>, merge.remap);
      if (next) await writeFileAtomic(full, JSON.stringify(next, null, 2) + "\n");
    } catch { /* An unreadable project is skipped, as listProjects skips it. */ }
  }
  // Keep the file's unknown presets and fields: only the merged twins leave.
  const removed = new Set(Object.keys(merge.remap));
  const presets = data.presets.filter((p) => !(isPreset(p) && removed.has(p.id)));
  await writeFileAtomic(presetsFile, JSON.stringify({ ...data, presets }, null, 2) + "\n");
  startupMerge = { ...merge.remap };
  return merge;
}
