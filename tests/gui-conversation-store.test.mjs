import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('archived conversations preserve views, filter account/workspace/harness, reject arbitrary IDs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aya-history-test-'));
  process.env.AYA_HOME = root;
  const { archiveConversation, listConversations, readArchivedConversation } = await import('../dist-electron/gui-conversation-store.js');
  const binding = { cwd: '/project', configDir: '/account', agent: 'codex' };
  const snapshot = { ...binding, threadId: 'thread-one', view: { messages: [{ type: 'user', text: 'First question' }], prompt: 'Draft', artifacts: [{ id: 'image', dataUrl: 'data:image/png;base64,abc' }] } };
  try {
    await archiveConversation(snapshot);
    const [row] = await listConversations(binding);
    assert.equal(row.title, 'First question');
    assert.deepEqual(await readArchivedConversation(row.id, binding), snapshot);
    await archiveConversation({ ...snapshot, view: { ...snapshot.view, prompt: 'Updated draft' } });
    assert.equal((await listConversations(binding)).length, 1);
    assert.equal((await readArchivedConversation(row.id, binding)).view.prompt, 'Updated draft');
    for (const other of [{ ...binding, cwd: '/elsewhere' }, { ...binding, configDir: '/account-b' }, { ...binding, agent: 'claude' }]) {
      assert.deepEqual(await listConversations(other), []);
      await assert.rejects(readArchivedConversation(row.id, other), /workspace and account/);
    }
    await assert.rejects(readArchivedConversation('../../secret', binding), /Invalid conversation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
