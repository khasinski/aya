import { promises as fs } from "node:fs";
import * as path from "node:path";
import { normalizePreset, type Preset } from "./presets";

export interface RepoProjectConfig {
  presets: Preset[];
}

export async function readRepoProjectConfig(
  directory: string,
): Promise<RepoProjectConfig | null> {
  const filePath = path.join(directory, ".aya", "project.json");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const data = JSON.parse(raw);
  const presets = Array.isArray(data?.presets)
    ? data.presets
        .map((preset: unknown) => normalizePreset(preset))
        .filter((preset: Preset | null): preset is Preset => preset !== null)
    : [];
  if (presets.length === 0) return null;
  return { presets };
}
