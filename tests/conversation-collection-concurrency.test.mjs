import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a slow collection scan does not delay another conversation save', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'aya-collection-concurrency-'));
  process.env.AYA_HOME = root;
  const { saveConversation, loadConversation, collectUnusedConversationAssets } = await import('../dist-electron/gui-conversation-store.js');
  const open = fs.open;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  try {
    await saveConversation('old', { cwd: '/project', view: { messages: [] } });
    fs.open = async (file, ...args) => {
      if (String(file).endsWith('.json') && args[0] === 'r') { entered(); await blocked; }
      return open(file, ...args);
    };
    const collection = collectUnusedConversationAssets();
    await waiting;
    const saved = saveConversation('new', { cwd: '/project', view: { prompt: 'saved during scan' } });
    let timeout;
    const result = await Promise.race([saved.then(() => 'saved'), new Promise(resolve => { timeout = setTimeout(() => resolve('blocked'), 2000); })]);
    clearTimeout(timeout);
    assert.equal(result, 'saved');
    release();
    assert.equal((await collection).aborted, true);
    assert.equal((await loadConversation('new')).view.prompt, 'saved during scan');
  } finally { release(); fs.open = open; await fs.rm(root, { recursive: true, force: true }); }
});
