// Artifacts for TUI panes: what `aya present` hands over, kept per pane and shown in a preview window. The GUI
// conversation keeps its own artifacts beside the messages (gui-artifact-tools.ts); this is the same set of kinds
// (html, image, table, metric) for an agent that only has a terminal. Each pane's artifacts are also kept on disk
// (one JSON file per pane under AYA_HOME/tui-artifacts), so they survive a restart. Pure of Electron, so plain Node
// tests import it.
import { createHash } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { presentArtifact } from "./gui-artifact-tools";
import { retainArtifactMedia, releaseArtifactMedia, validArtifactMedia } from './gui-artifact-media';
import { scheduleConversationAssetCollection } from './gui-conversation-store';
import { writeFileAtomic } from "./atomic-write";
import { readStoredJson } from "./stored-json";
import { AYA_HOME } from "./paths";
import type { GuiArtifact } from "../shared/codex-gui";
import type { TuiArtifactSummary } from "../shared/ipc-types";

export interface TuiArtifactInput {
  kind: "html" | "image" | "table" | "metric";
  title: string;
  html?: string;
  htmlBaseDir?: string;
  workspaceDir?: string;
  assets?: string[];
  imagePath?: string;
  columns?: string[];
  rows?: string[][];
  value?: string;
  description?: string;
  artifactId?: string;
}
export interface StoredArtifact { artifact: GuiArtifact; terminalId?: string; updatedAt: number }
export type { TuiArtifactSummary };
/** `opened`: the caller opens a window for it (aya present without --no-open). */
export type TuiArtifactListener = (terminalId: string | undefined, item: StoredArtifact, change: { updated: boolean; opened: boolean }) => void;

/** Kept in memory across all panes, oldest out first. */
export const MAX_TUI_ARTIFACTS = 100;
/** Kept on disk per pane: the newest this many, in at most PANE_FILE_LIMIT bytes (the GUI conversation's snapshot limit). */
export const MAX_TUI_ARTIFACTS_PER_PANE = 50;
export const PANE_FILE_LIMIT = 32 * 1024 * 1024;
/** A gone pane's artifacts are dropped once they are this old. */
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TUI_ARTIFACTS_DIR = path.join(AYA_HOME, "tui-artifacts");

const KINDS = new Set(["html", "image", "table", "metric"]);
const str = (v: unknown): v is string => typeof v === "string";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
/** A stored artifact read back from disk, or null when it is not one Aya wrote. */
function validStored(value: unknown, terminalId: string): StoredArtifact | null {
  const item = value as { artifact?: Record<string, unknown>; updatedAt?: unknown } | null;
  const a = item?.artifact;
  if (!a || !str(a.id) || !/^[\w-]{1,128}$/.test(a.id) || !str(a.title) || !KINDS.has(a.kind as string) || typeof item.updatedAt !== "number") return null;
  if (a.revision !== undefined && !Number.isSafeInteger(a.revision)) return null;
  const ok = a.kind === "html" ? str(a.html) && (a.media === undefined || (Array.isArray(a.media) && validArtifactMedia(a.media)))
    : a.kind === "image" ? str(a.path) && str(a.dataUrl) && a.dataUrl.startsWith("data:image/")
    : a.kind === "table" ? strings(a.columns) && Array.isArray(a.rows) && a.rows.every(strings)
    : str(a.value) && str(a.description);
  return ok ? { artifact: a as unknown as GuiArtifact, terminalId, updatedAt: item.updatedAt } : null;
}

export interface TuiArtifactStoreOptions {
  max?: number;
  now?: () => number;
  /** Where each pane's artifacts are kept; none keeps them in memory only. */
  dir?: string;
  perPane?: number;
  fileLimit?: number;
}

export class TuiArtifactStore {
  private readonly items = new Map<string, StoredArtifact>();
  private readonly listeners = new Set<TuiArtifactListener>();
  private readonly writes = new Map<string, Promise<void>>();
  private loading: Promise<void> | null = null;
  private readonly max: number;
  private readonly now: () => number;
  private readonly dir?: string;
  private readonly perPane: number;
  private readonly fileLimit: number;
  constructor(options: TuiArtifactStoreOptions | number = {}, now?: () => number) {
    const o = typeof options === "number" ? { max: options, now } : options;
    this.max = o.max ?? MAX_TUI_ARTIFACTS;
    this.now = o.now ?? (() => Date.now());
    this.dir = o.dir;
    this.perPane = o.perPane ?? MAX_TUI_ARTIFACTS_PER_PANE;
    this.fileLimit = o.fileLimit ?? PANE_FILE_LIMIT;
  }

  /** Reads what earlier runs kept, once; every other method may be called before it ends, but callers that list
   *  or open await it first. A damaged pane file is skipped, not deleted. */
  load(): Promise<void> {
    if (!this.loading) this.loading = this.readAll().catch((error) => console.warn("[aya] could not read the kept TUI artifacts", error));
    return this.loading;
  }

  private async readAll(): Promise<void> {
    if (!this.dir) return;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const found: StoredArtifact[] = [];
    for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
      try {
        const file = await readStoredJson(path.join(this.dir, name), this.fileLimit) as { terminalId?: unknown; items?: unknown };
        if (!str(file?.terminalId) || this.fileFor(file.terminalId) !== path.join(this.dir, name) || !Array.isArray(file.items)) continue;
        for (const raw of file.items) { const item = validStored(raw, file.terminalId); if (item) found.push(item); }
      } catch { /* not ours or damaged: leave it */ }
    }
    // Oldest first, so the newest are the last kept and the map's order stays "oldest first"; this run's own win.
    for (const item of found.sort((a, b) => a.updatedAt - b.updatedAt)) {
      if (this.items.has(item.artifact.id)) continue;
      this.items.set(item.artifact.id, item);
      retainArtifactMedia('tui:' + item.artifact.id, item.artifact.kind === 'html' ? item.artifact.media || [] : []);
    }
    this.trim();
  }

  private fileFor(terminalId: string): string {
    return path.join(this.dir!, createHash("sha256").update(terminalId).digest("hex") + ".json");
  }

  /** Writes the pane's file from memory: the newest perPane artifacts that fit in fileLimit. Writes per pane run in turn. */
  private persist(terminalId: string | undefined): Promise<void> {
    if (!this.dir || !terminalId) return Promise.resolve();
    const run = async () => {
      const file = this.fileFor(terminalId);
      const mine = this.list(terminalId).slice(0, this.perPane).map(({ artifact, updatedAt }) => ({ artifact, updatedAt }));
      if (!mine.length) { await unlink(file).catch(() => {}); return; }
      const encode = (items: typeof mine) => JSON.stringify({ version: 1, terminalId, items }, (key, value) => key === "previewUrl" ? undefined : value);
      let data = encode(mine);
      while (Buffer.byteLength(data) > this.fileLimit && mine.length) { mine.pop(); data = encode(mine); }
      if (!mine.length) { await unlink(file).catch(() => {}); return; }
      await writeFileAtomic(file, data, 0o600);
    };
    const next = (this.writes.get(terminalId) ?? Promise.resolve()).then(run).catch((error) => console.warn("[aya] could not keep a TUI artifact", error));
    this.writes.set(terminalId, next);
    void next.finally(() => { if (this.writes.get(terminalId) === next) this.writes.delete(terminalId); });
    return next;
  }

  /** Resolves once every pending write has landed (tests, quit). */
  async flush(): Promise<void> { await Promise.all([...this.writes.values()]); }

  private trim(): Set<string | undefined> {
    const touched = new Set<string | undefined>();
    while (this.items.size > this.max) {
      const id = this.items.keys().next().value!;
      touched.add(this.items.get(id)!.terminalId);
      this.items.delete(id); releaseArtifactMedia('tui:' + id);
    }
    return touched;
  }

  onChange(listener: TuiArtifactListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Validates and stores; with artifactId it replaces that artifact's content and bumps its revision. */
  async present(input: TuiArtifactInput, terminalId?: string, opened = false): Promise<{ stored: StoredArtifact; updated: boolean }> {
    await this.load();
    const previous = input.artifactId ? this.items.get(input.artifactId) : undefined;
    if (input.artifactId && !previous) throw new Error(`no artifact "${input.artifactId}"; list them with aya artifact list`);
    if (previous && previous.terminalId !== terminalId) throw new Error(`artifact "${input.artifactId}" belongs to another pane`);
    let root = input.imagePath ? path.dirname(path.resolve(input.imagePath)) : input.workspaceDir || input.htmlBaseDir || process.cwd();
    if (input.htmlBaseDir && path.relative(root, input.htmlBaseDir).split(path.sep).includes('..')) root = input.htmlBaseDir;
    const built = await presentArtifact(root, {
      kind: input.kind, title: input.title, html: input.html, path: input.imagePath ? path.basename(input.imagePath) : undefined,
      columns: input.columns, rows: input.rows, value: input.value, description: input.description, assets: input.assets,
    }, { htmlBaseDir: input.htmlBaseDir });
    const artifact = { ...built, id: previous ? previous.artifact.id : built.id, revision: previous ? (previous.artifact.revision ?? 1) + 1 : 1 } as GuiArtifact;
    this.items.delete(artifact.id);
    this.items.set(artifact.id, { artifact, ...(terminalId ? { terminalId } : {}), updatedAt: this.now() });
    retainArtifactMedia('tui:' + artifact.id, artifact.kind === 'html' ? artifact.media || [] : []);
    if (artifact.kind === 'html' && artifact.media?.length) scheduleConversationAssetCollection();
    const touched = this.trim();
    touched.add(terminalId);
    for (const pane of touched) void this.persist(pane);
    const stored = this.items.get(artifact.id)!;
    for (const listener of this.listeners) { try { listener(terminalId, stored, { updated: Boolean(previous), opened }); } catch (error) { console.warn("[aya] TUI artifact listener failed", error); } }
    return { stored, updated: Boolean(previous) };
  }

  get(id: string): StoredArtifact | undefined { return this.items.get(id); }

  /** Newest first; a pane sees only its own, a caller outside Aya sees all. */
  list(terminalId?: string): StoredArtifact[] {
    return [...this.items.values()].filter((item) => !terminalId || item.terminalId === terminalId).reverse();
  }

  /** Drops a pane's artifacts, from memory and disk. */
  forget(terminalId: string): Promise<void> {
    for (const [id, item] of this.items) if (item.terminalId === terminalId) { this.items.delete(id); releaseArtifactMedia('tui:' + id); }
    return this.persist(terminalId);
  }

  /** Forgets every pane not in `live` whose newest artifact is older than `minAgeMs`: a pane closed while Aya was not
   *  running. The age guard keeps a pane that a short project list (a file that failed to read) left out. */
  async prune(live: ReadonlySet<string>, minAgeMs = PRUNE_AFTER_MS): Promise<void> {
    await this.load();
    const cutoff = this.now() - minAgeMs, newest = new Map<string, number>();
    for (const { terminalId, updatedAt } of this.items.values()) if (terminalId) newest.set(terminalId, Math.max(newest.get(terminalId) ?? 0, updatedAt));
    await Promise.all([...newest].filter(([id, at]) => !live.has(id) && at <= cutoff).map(([id]) => this.forget(id)));
    if (!this.dir) return;
    const keep = new Set([...live, ...newest.keys()].map((id) => path.basename(this.fileFor(id))));
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n) && !keep.has(n))) {
      const file = path.join(this.dir, name);
      const modified = (await stat(file).catch(() => null))?.mtimeMs;
      if (modified !== undefined && modified <= cutoff) await unlink(file).catch(() => {});
    }
  }
}

export function summarizeArtifact(item: StoredArtifact): TuiArtifactSummary {
  const { artifact } = item;
  return { id: artifact.id, kind: artifact.kind, title: artifact.title, revision: artifact.revision ?? 1, updatedAt: item.updatedAt };
}

export function describeArtifact(item: StoredArtifact): string {
  const { artifact } = item;
  return `${artifact.id}  ${artifact.kind}  r${artifact.revision ?? 1}  ${artifact.title}`;
}

let shared: TuiArtifactStore | null = null;
/** The store main.ts uses, kept under AYA_HOME. */
export function tuiArtifactStore(): TuiArtifactStore {
  if (!shared) shared = new TuiArtifactStore({ dir: DEFAULT_TUI_ARTIFACTS_DIR });
  return shared;
}

/** A pane's artifacts, newest first, as the Conversation view's artifact drawer takes them (full content, latest
 *  revision only). For a pane switching from terminal to Conversation GUI mode to bring its `aya present` results. */
export async function paneTuiArtifacts(terminalId: string): Promise<GuiArtifact[]> {
  const store = tuiArtifactStore();
  await store.load();
  return store.list(terminalId).map((item) => item.artifact);
}
