import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { AYA_HOME } from './paths';
import { writeFileAtomic } from './atomic-write';
import { readStoredJson } from './stored-json';
import { mapConcurrent } from './bounded-map';

interface MessageReference { $ayaMessageParts: string[] }
let cached = new WeakMap<object, MessageReference>();
export function invalidateStoredMessages() { cached = new WeakMap(); }
const pending = new Map<string, Promise<void>>();
export const messageDirectory = () => path.join(AYA_HOME, 'conversations', 'messages');
const messageFile = (hash: string) => path.join(messageDirectory(), hash + '.json');
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function messageHashes(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('$ayaMessageParts' in value) || !Array.isArray(value.$ayaMessageParts) || !value.$ayaMessageParts.length || !value.$ayaMessageParts.every(validHash)) throw Error('Invalid conversation message reference');
  return value.$ayaMessageParts;
}
async function storeMessage(value: unknown): Promise<MessageReference> {
  if (!value || typeof value !== 'object') throw Error('Invalid conversation message');
  const existing = cached.get(value);
  if (existing) return existing;
  const text = JSON.stringify(value);
  const hashes: string[] = [];
  // Split serialized text, including oversized individual messages. JSON string
  // chunks preserve surrogate pairs even if a boundary falls between them.
  for (let at = 0; at < text.length; at += 128 * 1024) {
    const data = JSON.stringify(text.slice(at, at + 128 * 1024));
    const hash = createHash('sha256').update(data).digest('hex');
    hashes.push(hash);
    let write = pending.get(hash);
    if (!write) {
      write = (async () => {
        try { await stat(messageFile(hash)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await writeFileAtomic(messageFile(hash), data, 0o600);
        }
      })();
      pending.set(hash, write);
      void write.finally(() => { if (pending.get(hash) === write) pending.delete(hash); }).catch(() => {});
    }
    await write;
  }
  const ref = { $ayaMessageParts: hashes };
  cached.set(value, ref);
  return ref;
}
export async function storeMessages(view: Record<string, unknown> | undefined) {
  if (!view || !Array.isArray(view.messages)) return view;
  return { ...view, messages: await mapConcurrent(view.messages, 4, storeMessage) };
}
export async function loadMessages(view: Record<string, unknown> | undefined) {
  if (!view || !Array.isArray(view.messages)) return view;
  const messages = await mapConcurrent(view.messages, 4, async ref => {
    const chunks: string[] = [];
    for (const hash of messageHashes(ref)) {
      const chunk = await readStoredJson(messageFile(hash), 1024 * 1024);
      if (typeof chunk !== 'string' || createHash('sha256').update(JSON.stringify(chunk)).digest('hex') !== hash) throw Error('Conversation message chunk is damaged');
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(chunks.join(''));
    if (!value || typeof value !== 'object') throw Error('Invalid saved conversation message');
    cached.set(value, ref as MessageReference);
    return value;
  });
  return { ...view, messages };
}
