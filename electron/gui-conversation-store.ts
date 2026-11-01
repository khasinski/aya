import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { AYA_HOME } from './paths';
import { writeFileAtomic } from './atomic-write';
export interface ConversationSnapshot { cwd: string; configDir?: string; agent?: string; threadId?: string; view?: Record<string, unknown> }
const writes = new Map<string, Promise<void>>();
function file(id: string) { return path.join(AYA_HOME, 'conversations', createHash('sha256').update(id).digest('hex') + '.json'); }
export async function loadConversation(id: string): Promise<ConversationSnapshot | null> {
  try {
    await writes.get(id);
    const text = await readFile(file(id), 'utf8');
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error('Conversation snapshot is too large');
    const value = JSON.parse(text) as ConversationSnapshot;
    if (!value || typeof value.cwd !== 'string' || (value.threadId !== undefined && typeof value.threadId !== 'string')) throw Error('Invalid conversation snapshot');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function saveConversation(id: string, value: ConversationSnapshot) {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw Error('Conversation exceeds the 32 MB local history limit');
  const write = (writes.get(id) || Promise.resolve()).catch(() => {}).then(() => writeFileAtomic(file(id), data, 0o600));
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
      if (row.cwd === binding.cwd && row.configDir === binding.configDir && row.agent === (binding.agent || 'codex')) rows.push({ id: row.id, title: row.title, updatedAt: row.updatedAt, current: row.threadId === binding.threadId });
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
