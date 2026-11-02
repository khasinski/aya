import { createHash } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { AYA_HOME } from './paths';
import { writeFileAtomic } from './atomic-write';
import { readStoredJson, readStoredText } from './stored-json';
import { LatestSnapshotWriter } from './latest-snapshot-writer';
import { mapConcurrent } from './bounded-map';
import type { DeferredGuiArtifact, GuiArtifact } from '../shared/codex-gui';
export interface ConversationSnapshot { cwd: string; configDir?: string; agent?: string; threadId?: string; view?: Record<string, unknown> }
const writes = new Map<string, Promise<void>>();
const writers = new Map<string, LatestSnapshotWriter<ConversationSnapshot>>();
const SNAPSHOT_LIMIT = 32 * 1024 * 1024;
const ASSET_LIMIT = 32 * 1024 * 1024;
const activeStorage = new Set<Promise<unknown>>();
let collection: Promise<{ removed: number; aborted: boolean }> | null = null;
let collectionScheduled = false;
let nextCollectionAt = 0;
function scheduleCollection() {
  if (collectionScheduled || Date.now() < nextCollectionAt) return;
  collectionScheduled = true;
  setTimeout(() => {
    void collectUnusedConversationAssets().catch(error => console.warn('Conversation asset cleanup failed', error)).finally(() => {
      collectionScheduled = false; nextCollectionAt = Date.now() + 24 * 60 * 60 * 1000;
    });
  }, 60_000).unref();
}
async function withStorageAccess<T>(access: () => Promise<T>): Promise<T> {
  while (collection) await collection.catch(() => {});
  const task = access(); activeStorage.add(task);
  try { return await task; } finally { activeStorage.delete(task); }
}
function file(id: string) { return path.join(AYA_HOME, 'conversations', createHash('sha256').update(id).digest('hex') + '.json'); }
type ArtifactReference = { $ayaArtifact: string; id?: string; kind?: string; title?: string; revision?: number };
const assetWrites = new Map<string, Promise<void>>();
const storedArtifacts = new WeakMap<object, ArtifactReference>();
const assetFile = (hash: string) => path.join(AYA_HOME, 'conversations', 'assets', hash + '.json');
async function storeArtifact(artifact: unknown): Promise<ArtifactReference> {
  if (artifact && typeof artifact === 'object' && 'deferred' in artifact && artifact.deferred === true) {
    const reference = deferredArtifact(artifact);
    await stat(assetFile(reference.$ayaArtifact));
    const { deferred: _deferred, ...stored } = reference;
    return stored;
  }
  if (artifact && typeof artifact === 'object') {
    const stored = storedArtifacts.get(artifact);
    if (stored) {
      try { await stat(assetFile(stored.$ayaArtifact)); return stored; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const data = JSON.stringify(artifact, (key, value) => key === 'previewUrl' ? undefined : value);
  if (Buffer.byteLength(data) > ASSET_LIMIT) throw Error('Artifact exceeds the 32 MB local storage limit');
  const hash = createHash('sha256').update(data).digest('hex');
  let pending = assetWrites.get(hash);
  if (!pending) {
    pending = (async () => {
      try { await stat(assetFile(hash)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await writeFileAtomic(assetFile(hash), data, 0o600); }
    })();
    assetWrites.set(hash, pending);
    void pending.finally(() => { if (assetWrites.get(hash) === pending) assetWrites.delete(hash); }).catch(() => {});
  }
  await pending;
  const metadata = artifact && typeof artifact === 'object' ? artifact as Record<string, unknown> : {};
  const reference = { $ayaArtifact: hash, ...(typeof metadata.id === 'string' ? { id: metadata.id } : {}), ...(typeof metadata.kind === 'string' ? { kind: metadata.kind } : {}), ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}), ...(typeof metadata.revision === 'number' ? { revision: metadata.revision } : {}) };
  if (artifact && typeof artifact === 'object') storedArtifacts.set(artifact, reference);
  return reference;
}
async function loadArtifact(reference: unknown): Promise<unknown> {
  const hash = (reference as Partial<ArtifactReference> | null)?.$ayaArtifact;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid stored artifact reference');
  const data = await readStoredText(assetFile(hash), ASSET_LIMIT);
  if (createHash('sha256').update(data).digest('hex') !== hash) throw Error('Stored artifact is damaged');
  return JSON.parse(data);
}
function deferredArtifact(value: unknown): DeferredGuiArtifact {
  const ref = value as Partial<DeferredGuiArtifact> | null;
  if (!ref || typeof ref.$ayaArtifact !== 'string' || !/^[a-f0-9]{64}$/.test(ref.$ayaArtifact) || typeof ref.id !== 'string' || typeof ref.title !== 'string' || !['html', 'image', 'table', 'metric'].includes(ref.kind || '')) throw Error('Invalid stored artifact reference');
  return { id: ref.id, title: ref.title, kind: ref.kind!, ...(ref.revision !== undefined ? { revision: ref.revision } : {}), $ayaArtifact: ref.$ayaArtifact, deferred: true };
}
export async function hydrateConversationArtifact(reference: DeferredGuiArtifact): Promise<GuiArtifact> {
  return withStorageAccess(async () => {
    const ref = deferredArtifact(reference);
    const artifact = await loadArtifact(ref) as GuiArtifact;
    if (artifact.id !== ref.id || artifact.kind !== ref.kind || artifact.title !== ref.title || (artifact.revision || 1) !== (ref.revision || 1)) throw Error('Stored artifact metadata is damaged');
    return artifact;
  });
}
async function mapArtifacts(view: Record<string, unknown> | undefined, map: (value: unknown) => Promise<unknown>) {
  if (!view) return view;
  const next = { ...view };
  if (Array.isArray(view.artifacts)) next.artifacts = await mapConcurrent(view.artifacts, 4, map);
  if (view.artifactHistory && typeof view.artifactHistory === 'object') {
    next.artifactHistory = Object.fromEntries(await mapConcurrent(Object.entries(view.artifactHistory), 4, async ([id, versions]) => [id, Array.isArray(versions) ? await mapConcurrent(versions, 1, map) : versions]));
  }
  return next;
}
function validateArtifactLayout(view: Record<string, unknown> | undefined) {
  if (view === undefined) return;
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw Error('Invalid conversation view');
  if (view.artifacts !== undefined && !Array.isArray(view.artifacts)) throw Error('Invalid artifact list');
  if (view.artifactHistory !== undefined && (!view.artifactHistory || typeof view.artifactHistory !== 'object' || Array.isArray(view.artifactHistory) || Object.values(view.artifactHistory).some(versions => !Array.isArray(versions)))) throw Error('Invalid artifact history');
}
export async function loadConversation(id: string, options: { lazyArtifacts?: boolean } = {}): Promise<ConversationSnapshot | null> {
  await writes.get(id);
  return withStorageAccess(async () => {
  try {
    const stored = await readStoredJson(file(id), SNAPSHOT_LIMIT) as ConversationSnapshot & { storageVersion?: number };
    if (!stored || typeof stored.cwd !== 'string' || (stored.threadId !== undefined && typeof stored.threadId !== 'string')) throw Error('Invalid conversation snapshot');
    const { storageVersion, ...value } = stored;
    if (storageVersion !== undefined && storageVersion !== 2) throw Error('Unsupported conversation storage version');
    validateArtifactLayout(value.view);
    if (storageVersion === 2) {
      const assets = new Map<string, Promise<unknown>>();
      value.view = await mapArtifacts(value.view, reference => {
        if (options.lazyArtifacts) return Promise.resolve(deferredArtifact(reference));
        const hash = (reference as Partial<ArtifactReference> | null)?.$ayaArtifact;
        if (typeof hash !== 'string') return loadArtifact(reference);
        let loaded = assets.get(hash);
        if (!loaded) { loaded = loadArtifact(reference); assets.set(hash, loaded); }
        return loaded;
      });
    }
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    // A missing snapshot is an empty panel; a missing asset must not silently erase an existing conversation.
    try { await stat(file(id)); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null; throw missing; }
    throw Error('An artifact file is missing from this conversation');
  } throw error; }
  });
}
export function saveConversation(id: string, value: ConversationSnapshot) {
  // Capture the caller's state before another UI update replaces snapshot.view.
  const snapshot = { ...value, ...(value.view ? { view: { ...value.view } } : {}) };
  let writer = writers.get(id);
  if (!writer) {
    writer = new LatestSnapshotWriter(snapshot => withStorageAccess(async () => {
      validateArtifactLayout(snapshot.view);
      const stored = { ...snapshot, storageVersion: 2, view: await mapArtifacts(snapshot.view, storeArtifact) };
      const data = JSON.stringify(stored);
      if (Buffer.byteLength(data) > SNAPSHOT_LIMIT) throw Error('Conversation text exceeds the 32 MB local history limit');
      // Referenced assets are fully committed before publishing the new snapshot.
      await writeFileAtomic(file(id), data, 0o600);
      scheduleCollection();
    }));
    writers.set(id, writer);
  }
  const write = writer.save(snapshot);
  writes.set(id, write);
  void write.finally(() => { if (writes.get(id) === write) { writes.delete(id); writers.delete(id); } }).catch(() => {});
  return write;
}

function historyId(value: ConversationSnapshot) { return createHash('sha256').update(JSON.stringify([value.cwd, value.configDir || '', value.agent || 'codex', value.threadId])).digest('hex'); }
export async function archiveConversation(value: ConversationSnapshot) {
  if (!value.threadId) return;
  const id = historyId(value);
  await saveConversation('history:' + id, value);
  const messages = Array.isArray(value.view?.messages) ? value.view.messages : [];
  const first = messages.find((m: { type?: string; text?: string }) => m.type === 'user');
  await writeFileAtomic(path.join(AYA_HOME, 'conversations', 'history', id + '.json'), JSON.stringify({ id, cwd: value.cwd, configDir: value.configDir, agent: value.agent || 'codex', threadId: value.threadId, title: String(first?.text || 'Untitled conversation').slice(0, 160), updatedAt: Date.now() }), 0o600);
  historyGeneration++;
}
interface HistoryRow { id: string; cwd: string; configDir?: string; agent: string; threadId: string; title: string; updatedAt: number }
const historyFiles = new Map<string, { signature: string; row: HistoryRow | null }>();
let historyGeneration = 0;
let historyIndex: { signature: string; generation: number; rows: HistoryRow[] } | null = null;
let historyRead: Promise<HistoryRow[]> | null = null;
async function readHistoryIndex(): Promise<HistoryRow[]> {
  const dir = path.join(AYA_HOME, 'conversations', 'history');
  let directory;
  try { directory = await stat(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { historyIndex = null; historyFiles.clear(); return []; } throw error; }
  const signature = `${directory.dev}:${directory.ino}:${directory.mtimeMs}:${directory.ctimeMs}`;
  if (historyIndex?.signature === signature && historyIndex.generation === historyGeneration) return historyIndex.rows;
  const generation = historyGeneration;
  const names = (await readdir(dir)).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
  const present = new Set(names);
  for (const name of historyFiles.keys()) if (!present.has(name)) historyFiles.delete(name);
  const entries = await mapConcurrent(names, 8, async name => {
    try {
      const file = path.join(dir, name), info = await stat(file);
      const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = historyFiles.get(name);
      if (cached?.signature === signature) return cached.row;
      const value = await readStoredJson(file, 4096) as HistoryRow;
      const row = value && value.id === name.slice(0, -5) && typeof value.cwd === 'string' && typeof value.agent === 'string' && typeof value.threadId === 'string' && typeof value.title === 'string' && Number.isFinite(value.updatedAt) ? value : null;
      historyFiles.set(name, { signature, row });
      if (historyFiles.size > 4096) historyFiles.delete(historyFiles.keys().next().value!);
      return row;
    } catch { return null; /* A damaged entry must not hide other conversations. */ }
  });
  const rows = entries.filter((row): row is HistoryRow => !!row).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  // Retain only metadata, with a ceiling even for exceptionally large libraries.
  if (rows.length <= 10_000 && generation === historyGeneration) historyIndex = { signature, generation, rows };
  else historyIndex = null;
  return rows;
}
export async function listConversations(binding: ConversationSnapshot, options: { query?: string; offset?: number; limit?: number } = {}) {
  if (!historyRead) {
    const read = readHistoryIndex(); historyRead = read;
    void read.finally(() => { if (historyRead === read) historyRead = null; }).catch(() => {});
  }
  const rows = await historyRead;
  const offset = Math.max(0, Math.floor(options.offset || 0));
  const limit = Math.max(1, Math.floor(options.limit || 100));
  const query = (options.query || '').toLowerCase();
  return rows.filter(row => row.cwd === binding.cwd && row.configDir === binding.configDir && row.agent === (binding.agent || 'codex') && row.title.toLowerCase().includes(query))
    .slice(offset, offset + limit).map(row => ({ id: row.id, threadId: row.threadId, title: row.title, updatedAt: row.updatedAt, current: row.threadId === binding.threadId }));
}

/** Stop writers only during collection. Never delete a referenced version, and
 * refuse collection if any snapshot cannot be interpreted safely. */
export function collectUnusedConversationAssets(now = Date.now()): Promise<{ removed: number; aborted: boolean }> {
  if (collection) return collection;
  const running = [...activeStorage];
  const task = Promise.resolve().then(async () => {
    await Promise.allSettled(running);
    const root = path.join(AYA_HOME, 'conversations');
    let names: string[];
    try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, aborted: false }; throw error; }
    const referenced = new Set<string>();
    try {
      for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
        const snapshot = await readStoredJson(path.join(root, name), SNAPSHOT_LIMIT) as ConversationSnapshot & { storageVersion?: number };
        if (!snapshot || typeof snapshot.cwd !== 'string' || ![undefined, 2].includes(snapshot.storageVersion)) throw Error('Invalid snapshot');
        validateArtifactLayout(snapshot.view);
        if (snapshot.storageVersion === 2) await mapArtifacts(snapshot.view, async value => {
          const hash = (value as ArtifactReference | null)?.$ayaArtifact;
          if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid artifact reference');
          referenced.add(hash); return value;
        });
      }
    } catch { return { removed: 0, aborted: true }; }
    let assets: string[];
    try { assets = await readdir(path.join(root, 'assets')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, aborted: false }; throw error; }
    let removed = 0;
    for (const name of assets.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      if (referenced.has(name.slice(0, -5))) continue;
      const target = path.join(root, 'assets', name);
      try {
        const info = await stat(target);
        if (now - info.mtimeMs < 7 * 24 * 60 * 60 * 1000) continue;
        await unlink(target); removed++;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { removed, aborted: false };
  });
  collection = task;
  void task.finally(() => { if (collection === task) collection = null; }).catch(() => {});
  return task;
}
export async function readArchivedConversation(id: string, binding: ConversationSnapshot, options: { lazyArtifacts?: boolean } = {}) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid conversation');
  const saved = await loadConversation('history:' + id, options);
  if (!saved || saved.cwd !== binding.cwd || saved.configDir !== binding.configDir || (saved.agent || 'codex') !== (binding.agent || 'codex')) throw Error('Conversation does not belong to this workspace and account');
  return saved;
}
