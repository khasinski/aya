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
    assert.equal(row.threadId, 'thread-one', 'history listing carries IDs without opening full conversation snapshots');
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

test('large artifact payloads live outside the snapshot, deduplicate revisions and migrate inline saves', async t => {
  const { readFile, readdir, writeFile, unlink } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  // The store module owns AYA_HOME from this test process's first import.
  const { AYA_HOME } = await import('../dist-electron/paths.js');
  const { saveConversation, loadConversation } = await import('../dist-electron/gui-conversation-store.js');
  t.after(() => rm(AYA_HOME, { recursive: true, force: true }));
  const directory = path.join(AYA_HOME, 'conversations');
  const snapshotFile = id => path.join(directory, createHash('sha256').update(id).digest('hex') + '.json');
  const payload = '<h1>Widget</h1>' + ' '.repeat(2 * 1024 * 1024 - 15);
  const artifacts = Array.from({ length: 20 }, (_, i) => ({ id: `large-${i}`, kind: 'html', title: `Large widget ${i}`, revision: 1, html: payload }));
  const snapshot = { cwd: '/large-project', threadId: 'large-thread', view: { prompt: 'Keep this draft', artifacts, artifactHistory: Object.fromEntries(artifacts.map(a => [a.id, [a]])), seenArtifactRevisions: { 'large-0': 1 } } };
  await saveConversation('large-panel', snapshot);
  const text = await readFile(snapshotFile('large-panel'), 'utf8');
  assert.ok(text.length < 16384, 'metadata stays small even when artifacts exceed 32 MB');
  assert.equal((await readdir(path.join(directory, 'assets'))).length, 20);
  assert.deepEqual(await loadConversation('large-panel'), snapshot);
  const legacy = { cwd: '/legacy-project', view: { artifacts: [{ id: 'old', kind: 'html', title: 'Old widget', html: '<h1>Legacy</h1>' }] } };
  await writeFile(snapshotFile('legacy-panel'), JSON.stringify(legacy));
  assert.deepEqual(await loadConversation('legacy-panel'), legacy);
  await saveConversation('legacy-panel', legacy);
  assert.equal(JSON.parse(await readFile(snapshotFile('legacy-panel'), 'utf8')).storageVersion, 2);
  assert.deepEqual(await loadConversation('legacy-panel'), legacy);
  const reference = JSON.parse(text).view.artifacts[0].$ayaArtifact;
  await unlink(path.join(directory, 'assets', reference + '.json'));
  await assert.rejects(loadConversation('large-panel'), /artifact file is missing/);
});

test('a refused save preserves the last snapshot and artifact references cannot escape the asset directory', async t => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { AYA_HOME } = await import('../dist-electron/paths.js');
  const { saveConversation, loadConversation } = await import('../dist-electron/gui-conversation-store.js');
  t.after(() => rm(AYA_HOME, { recursive: true, force: true }));
  const snapshot = { cwd: '/project', view: { prompt: 'Last saved draft', artifacts: [] } };
  await saveConversation('atomic-panel', snapshot);
  await assert.rejects(saveConversation('atomic-panel', { ...snapshot, view: { ...snapshot.view, prompt: 'x'.repeat(33 * 1024 * 1024) } }), /text exceeds/);
  assert.deepEqual(await loadConversation('atomic-panel'), snapshot);
  const file = path.join(AYA_HOME, 'conversations', createHash('sha256').update('atomic-panel').digest('hex') + '.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.view.artifacts = [{ $ayaArtifact: '../../outside' }];
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(loadConversation('atomic-panel'), /Invalid stored artifact reference/);
});
