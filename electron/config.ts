// Project config persistence — JSON-per-project under ~/.aya/projects/.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import {
  OPEN_PROJECTS_FILE,
  PROJECTS_DIR,
  PROJECTS_ORDER_FILE,
  PROJECTS_STATE_FILE,
} from "./paths";
import type { ProjectCollectionState, ProjectConfig, SplitLayout } from "./types";
import {
  MAX_SPLIT_COLS,
  MAX_SPLIT_ROWS,
  PROJECT_STATE_VERSION,
  sanitizeStringRecord,
} from "./validation";
import { slugifyName } from "./text";

const RESERVED_SLUGS = new Set(["aya-sentinel-new"]);

function slugify(name: string): string {
  return slugifyName(name, "project");
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

/** Normalize a raw tab object from disk: drop bad shapes, backfill name, and
 *  migrate the old `kind` field to the new `presetId`. */
export function normalizeTab(
  raw: unknown,
): { id: string; presetId: string; name: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  // Pre-presets format used `kind: "claude" | "codex" | "shell"`. Migrate.
  let presetId: string | null = null;
  if (typeof r.presetId === "string" && r.presetId) presetId = r.presetId;
  else if (typeof r.kind === "string" && r.kind) presetId = r.kind;
  if (!presetId) return null;
  const name =
    typeof r.name === "string" && r.name.trim() ? r.name : presetId;
  return { id: r.id, presetId, name };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((s) => typeof s === "string")
    ? value
    : null;
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0,
  );
}

export function normalizeSplitLayout(
  raw: unknown,
  tabIds: Set<string>,
): SplitLayout | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const rows =
    typeof r.rows === "number" && Number.isInteger(r.rows)
      ? Math.max(1, Math.min(MAX_SPLIT_ROWS, r.rows))
      : 1;
  const cols =
    typeof r.cols === "number" && Number.isInteger(r.cols)
      ? Math.max(1, Math.min(MAX_SPLIT_COLS, r.cols))
      : 1;
  const size = rows * cols;
  const rowFr = (numberArray(r.rowFr) ?? []).slice(0, rows);
  const colFr = (numberArray(r.colFr) ?? []).slice(0, cols);
  while (rowFr.length < rows) rowFr.push(1);
  while (colFr.length < cols) colFr.push(1);
  const rawCells = Array.isArray(r.cells) ? r.cells : [];
  const seenCells = new Set<string>();
  const cells = Array.from({ length: size }, (_, idx) => {
    const value = rawCells[idx];
    if (typeof value !== "string" || !tabIds.has(value) || seenCells.has(value)) {
      return null;
    }
    seenCells.add(value);
    return value;
  });
  const activeCell =
    typeof r.activeCell === "number" && Number.isInteger(r.activeCell)
      ? Math.max(0, Math.min(size - 1, r.activeCell))
      : 0;
  const assigned = cells.filter(Boolean).length;
  if (assigned === 0) return undefined;
  if (rows === 1 && cols === 1 && assigned <= 1) return undefined;
  return { rows, cols, rowFr, colFr, cells, activeCell };
}

function normalizeRemoteProject(raw: unknown): ProjectConfig["remote"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.hostId !== "string" ||
    !r.hostId ||
    typeof r.label !== "string" ||
    !r.label ||
    typeof r.sshTarget !== "string" ||
    !r.sshTarget ||
    typeof r.directory !== "string" ||
    !r.directory
  ) {
    return undefined;
  }
  return {
    hostId: r.hostId,
    label: r.label,
    sshTarget: r.sshTarget,
    directory: r.directory,
  };
}

async function loadStringArrayFile(filePath: string): Promise<string[] | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    return stringArray(data);
  } catch {
    // ENOENT or malformed — caller decides the fallback.
    return null;
  }
}

export function normalizeProjectState(
  raw: unknown,
): ProjectCollectionState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const order = stringArray(r.order);
  const open = stringArray(r.open);
  const recent = stringArray(r.recent);
  if (!order || !open || !recent) return null;
  return {
    version: PROJECT_STATE_VERSION,
    order,
    open,
    recent,
    activeProject: typeof r.activeProject === "string" ? r.activeProject : null,
    activeTab: sanitizeStringRecord(r.activeTab),
    singleView: sanitizeStringRecord(r.singleView),
  };
}

export async function listProjectState(): Promise<ProjectCollectionState> {
  try {
    const raw = await fs.readFile(PROJECTS_STATE_FILE, "utf-8");
    const parsed = normalizeProjectState(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Missing or malformed new state falls back to legacy files.
  }

  const order = (await loadStringArrayFile(PROJECTS_ORDER_FILE)) ?? [];
  const open = (await loadStringArrayFile(OPEN_PROJECTS_FILE)) ?? order;
  const recent = order.length > 0 ? order : open;
  const migrated: ProjectCollectionState = {
    version: PROJECT_STATE_VERSION,
    order,
    open,
    recent,
  };
  if (order.length > 0 || open.length > 0) {
    await saveProjectState(migrated);
  }
  return migrated;
}

export async function saveProjectState(
  state: ProjectCollectionState,
): Promise<void> {
  // Persist through the SAME normalizer the loader uses, so read and write can
  // never diverge: every field the schema knows about is round-tripped, and no
  // future field can be silently dropped by a hand-maintained pick list (that
  // bug — a dropped activeTab/activeProject — is exactly what reset the active
  // selection on restart, #18).
  const normalized = normalizeProjectState(state) ?? {
    version: PROJECT_STATE_VERSION,
    order: [],
    open: [],
    recent: [],
    activeProject: null,
    activeTab: {},
    singleView: {},
  };
  await writeFileAtomic(
    PROJECTS_STATE_FILE,
    JSON.stringify(normalized, null, 2) + "\n",
  );
}

export async function listProjects(): Promise<ProjectConfig[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROJECTS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ProjectConfig[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith(".json")) continue;
    const slug = file.slice(0, -5);
    try {
      const raw = await fs.readFile(path.join(PROJECTS_DIR, file), "utf-8");
      const data = JSON.parse(raw);
      if (typeof data.name !== "string" || typeof data.directory !== "string") {
        continue;
      }
      const rawTabs: unknown[] = Array.isArray(data.tabs) ? data.tabs : [];
      const tabs = rawTabs
        .map((t: unknown) => normalizeTab(t))
        .filter(
          (t): t is NonNullable<ReturnType<typeof normalizeTab>> => t !== null,
        );
      const splitLayout = normalizeSplitLayout(
        data.splitLayout,
        new Set(tabs.map((tab) => tab.id)),
      );
      const remote = normalizeRemoteProject(data.remote);
      out.push({
        slug,
        name: data.name,
        directory: data.directory,
        tabs,
        ...(splitLayout ? { splitLayout } : {}),
        ...(remote ? { remote } : {}),
      });
    } catch {
      // Skip invalid JSON; don't crash the app.
    }
  }
  // Apply user's custom order if any. Unknown slugs (e.g. new projects since
  // the last reorder) go to the end in their alphabetical order.
  const { order } = await listProjectState();
  if (order.length === 0) return out;
  const indexBySlug = new Map<string, number>();
  order.forEach((s, i) => indexBySlug.set(s, i));
  out.sort((a, b) => {
    const ia = indexBySlug.get(a.slug);
    const ib = indexBySlug.get(b.slug);
    if (ia === undefined && ib === undefined) return a.slug.localeCompare(b.slug);
    if (ia === undefined) return 1;
    if (ib === undefined) return -1;
    return ia - ib;
  });
  return out;
}

export async function createProject(
  name: string,
  directory: string,
): Promise<ProjectConfig> {
  await ensureDir();
  const slug = slugify(name);
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Project name "${name}" produces a reserved slug.`);
  }
  const filePath = path.join(PROJECTS_DIR, `${slug}.json`);
  try {
    await fs.access(filePath);
    throw new Error(`Project "${slug}" already exists.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const absDir = path.resolve(directory.replace(/^~/, os.homedir()));
  const project: ProjectConfig = {
    slug,
    name,
    directory: absDir,
    tabs: [],
  };
  await writeFileAtomic(filePath, JSON.stringify(toDisk(project), null, 2) + "\n");
  return project;
}

export async function createRemoteProject(req: {
  name: string;
  directory: string;
  hostId: string;
  label: string;
  sshTarget: string;
}): Promise<ProjectConfig> {
  await ensureDir();
  const slug = slugify(`${req.label}-${req.name}`);
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Project name "${req.name}" produces a reserved slug.`);
  }
  const filePath = path.join(PROJECTS_DIR, `${slug}.json`);
  try {
    await fs.access(filePath);
    throw new Error(`Project "${slug}" already exists.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const project: ProjectConfig = {
    slug,
    name: req.name,
    directory: req.directory,
    tabs: [],
    remote: {
      hostId: req.hostId,
      label: req.label,
      sshTarget: req.sshTarget,
      directory: req.directory,
    },
  };
  await writeFileAtomic(filePath, JSON.stringify(toDisk(project), null, 2) + "\n");
  return project;
}

export async function updateProject(project: ProjectConfig): Promise<void> {
  await ensureDir();
  const filePath = path.join(PROJECTS_DIR, `${project.slug}.json`);
  await writeFileAtomic(filePath, JSON.stringify(toDisk(project), null, 2) + "\n");
}

export async function deleteProject(slug: string): Promise<void> {
  const filePath = path.join(PROJECTS_DIR, `${slug}.json`);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function toDisk(project: ProjectConfig): unknown {
  return {
    name: project.name,
    directory: project.directory,
    tabs: project.tabs,
    ...(project.splitLayout ? { splitLayout: project.splitLayout } : {}),
    ...(project.remote ? { remote: project.remote } : {}),
  };
}

export function expandPath(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
