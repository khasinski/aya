import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

test('history above 32 MiB round-trips, changes incrementally and survives collection', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'aya-large-history-'));
  process.env.AYA_HOME = root;
  const { saveConversation, loadConversation, collectUnusedConversationAssets, archiveConversation, listConversations, readArchivedConversation } = await import('../dist-electron/gui-conversation-store.js');
  try {
    const messages = Array.from({ length: 35 }, (_, i) => ({ id: `m${i}`, type: 'assistant', text: `${i}:` + 'ą'.repeat(512 * 1024) }));
    const snapshot = { cwd: '/project', agent: 'codex', threadId: 'large', view: { messages, prompt: 'new draft' } };
    await saveConversation('large', snapshot);
    const file = join(root, 'conversations', createHash('sha256').update('large').digest('hex') + '.json');
    assert.ok((await fs.stat(file)).size < 30000);
    assert.deepEqual(await loadConversation('large'), snapshot);
    const folder = join(root, 'conversations', 'messages');
    const before = new Map(await Promise.all((await fs.readdir(folder)).map(async name => [name, (await fs.stat(join(folder, name))).mtimeMs])));
    await saveConversation('large', { ...snapshot, view: { ...snapshot.view, prompt: 'another draft' } });
    for (const [name, time] of before) assert.equal((await fs.stat(join(folder, name))).mtimeMs, time);
    await archiveConversation(snapshot);
    const [row] = await listConversations(snapshot);
    assert.deepEqual(await readArchivedConversation(row.id, snapshot), snapshot);
    await collectUnusedConversationAssets(Date.now() + 8 * 24 * 60 * 60 * 1000);
    assert.equal((await loadConversation('large')).view.messages.length, 35);
    // One single message can also exceed the previous snapshot ceiling.
    const huge = { cwd: '/project', view: { messages: [{ id: 'huge', text: 'x'.repeat(33 * 1024 * 1024) }] } };
    await saveConversation('huge', huge);
    assert.deepEqual(await loadConversation('huge'), huge);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
