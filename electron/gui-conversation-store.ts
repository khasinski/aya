import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { AYA_HOME } from './paths';
import { writeFileAtomic } from './atomic-write';
export interface ConversationSnapshot { cwd: string; configDir?: string; agent?: string; threadId?: string; view?: Record<string, unknown> }
const writes = new Map<string, Promise<void>>();
function file(id: string) { return path.join(AYA_HOME, 'conversations', createHash('sha256').update(id).digest('hex') + '.json'); }
type ArtifactReference = { $ayaArtifact: string; id?: string; kind?: string; title?: string; revision?: number };
const assetWrites = new Map<string, Promise<void>>();
const storedArtifacts = new WeakMap<object, ArtifactReference>();
const assetFile = (hash: string) => path.join(AYA_HOME, 'conversations', 'assets', hash + '.json');
async function storeArtifact(artifact: unknown): Promise<ArtifactReference> {
  if (artifact && typeof artifact === 'object') {
    const stored = storedArtifacts.get(artifact);
    if (stored) {
      try { await stat(assetFile(stored.$ayaArtifact)); return stored; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const data = JSON.stringify(artifact, (key, value) => key === 'previewUrl' ? undefined : value);
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
  const data = await readFile(assetFile(hash), 'utf8');
  if (createHash('sha256').update(data).digest('hex') !== hash) throw Error('Stored artifact is damaged');
  return JSON.parse(data);
}
async function mapArtifacts(view: Record<string, unknown> | undefined, map: (value: unknown) => Promise<unknown>) {
  if (!view) return view;
  const next = { ...view };
  if (Array.isArray(view.artifacts)) next.artifacts = await Promise.all(view.artifacts.map(map));
  if (view.artifactHistory && typeof view.artifactHistory === 'object') {
    next.artifactHistory = Object.fromEntries(await Promise.all(Object.entries(view.artifactHistory).map(async ([id, versions]) => [id, Array.isArray(versions) ? await Promise.all(versions.map(map)) : versions])));
  }
  return next;
}
export async function loadConversation(id: string): Promise<ConversationSnapshot | null> {
  try {
    await writes.get(id);
    const text = await readFile(file(id), 'utf8');
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error('Conversation snapshot is too large');
    const stored = JSON.parse(text) as ConversationSnapshot & { storageVersion?: number };
    if (!stored || typeof stored.cwd !== 'string' || (stored.threadId !== undefined && typeof stored.threadId !== 'string')) throw Error('Invalid conversation snapshot');
    const { storageVersion, ...value } = stored;
    if (storageVersion !== undefined && storageVersion !== 2) throw Error('Unsupported conversation storage version');
    if (storageVersion === 2) {
      const assets = new Map<string, Promise<unknown>>();
      value.view = await mapArtifacts(value.view, reference => {
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
}
export function saveConversation(id: string, value: ConversationSnapshot) {
  // Capture the caller's state before another UI update replaces snapshot.view.
  const snapshot = { ...value, ...(value.view ? { view: { ...value.view } } : {}) };
  const write = (writes.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
    const stored = { ...snapshot, storageVersion: 2, view: await mapArtifacts(snapshot.view, storeArtifact) };
    const data = JSON.stringify(stored);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw Error('Conversation text exceeds the 32 MB local history limit');
    // Referenced assets are fully committed before publishing the new snapshot.
    await writeFileAtomic(file(id), data, 0o600);
  });
  writes.set(id, write);
  void write.finally(() => { if (writes.get(id) === write) writes.delete(id); }).catch(() => {});
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
}
export async function listConversations(binding: ConversationSnapshot) {
  const dir = path.join(AYA_HOME, 'conversations', 'history');
  let names: string[];
  try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const rows: Record<string, unknown>[] = [];
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    try {
      const text = await readFile(path.join(dir, name), 'utf8');
      if (text.length > 4096) continue;
      const row = JSON.parse(text);
      if (row.cwd === binding.cwd && row.configDir === binding.configDir && row.agent === (binding.agent || 'codex')) rows.push({ id: row.id, threadId: row.threadId, title: row.title, updatedAt: row.updatedAt, current: row.threadId === binding.threadId });
    } catch { /* A damaged entry must not hide other conversations. */ }
  }
  return rows.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)).slice(0, 100);
}
export async function readArchivedConversation(id: string, binding: ConversationSnapshot) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid conversation');
  const saved = await loadConversation('history:' + id);
  if (!saved || saved.cwd !== binding.cwd || saved.configDir !== binding.configDir || (saved.agent || 'codex') !== (binding.agent || 'codex')) throw Error('Conversation does not belong to this workspace and account');
  return saved;
}
