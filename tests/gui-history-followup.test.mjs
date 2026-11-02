import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(tmpdir(), 'aya-history-followup-'));
process.env.AYA_HOME = root;
const store = await import('../dist-electron/gui-conversation-store.js');
const { readStoredJson } = await import('../dist-electron/stored-json.js');
const directory = path.join(root, 'conversations');
const snapshotPath = id => path.join(directory, createHash('sha256').update(id).digest('hex') + '.json');
const binding = { cwd: '/project', agent: 'pi' };
beforeEach(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true }); });
after(() => fs.rm(root, { recursive: true, force: true }));

test('history searches beyond the first page, reuses the index and refreshes atomic changes', async t => {
  for (let i = 0; i < 105; i++) await store.archiveConversation({ ...binding, threadId: String(i), view: { messages: [{ type: 'user', text: `Question ${i}` }] } });
  const first = await store.listConversations(binding);
  assert.equal(first.length, 100);
  const opening = t.mock.method(fs, 'open');
  const second = await store.listConversations(binding, { offset: 100 });
  assert.equal(second.length, 5);
  assert.equal(opening.mock.callCount(), 0, 'unchanged listing uses the metadata index');
  assert.equal(new Set([...first, ...second].map(row => row.id)).size, 105);
  const oldest = second.at(-1);
  assert.equal((await store.listConversations(binding, { query: oldest.title })).some(row => row.id === oldest.id), true);
  await store.archiveConversation({ ...binding, threadId: oldest.threadId, view: { messages: [{ type: 'user', text: 'Renamed old conversation' }] } });
  assert.equal((await store.listConversations(binding, { query: 'Renamed old' }))[0].id, oldest.id);
  assert.deepEqual(await store.listConversations({ ...binding, cwd: '/other' }), []);
});

test('stored JSON rejects oversized files before reading and notices growth during a read', async t => {
  const file = path.join(root, 'metadata.json');
  await fs.writeFile(file, '{}'); await fs.truncate(file, 4097);
  const original = fs.open.bind(fs);
  let reads = 0;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args), read = handle.read.bind(handle);
    handle.read = (...args) => { reads++; return read(...args); };
    return handle;
  });
  await assert.rejects(readStoredJson(file, 4096), /too large/); assert.equal(reads, 0);
  mock.mock.restore();
  await fs.writeFile(file, '{}');
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args), stat = handle.stat.bind(handle);
    handle.stat = async () => { const info = await stat(); await fs.writeFile(file, 'x'.repeat(100)); return info; };
    return handle;
  });
  await assert.rejects(readStoredJson(file, 32), /too large/);
});

test('collection keeps every referenced archived revision and young orphan, deleting only old orphans', async () => {
  const artifact = text => ({ id: 'widget', kind: 'html', title: text, html: text });
  await store.archiveConversation({ ...binding, threadId: 'kept', view: { artifacts: [artifact('archived')] } });
  await store.saveConversation('panel', { ...binding, view: { artifacts: [artifact('orphan')] } });
  await store.saveConversation('panel', { ...binding, view: { artifacts: [artifact('current')], artifactHistory: { widget: [artifact('old referenced revision')] } } });
  const assets = path.join(directory, 'assets');
  const old = new Date(Date.now() - 8 * 86400_000);
  for (const file of await fs.readdir(assets)) await fs.utimes(path.join(assets, file), old, old);
  await fs.writeFile(path.join(assets, 'f'.repeat(64) + '.json'), '{}');
  assert.deepEqual(await store.collectUnusedConversationAssets(), { removed: 1, aborted: false });
  assert.equal((await fs.readdir(assets)).length, 4);
  const [archived] = await store.listConversations(binding);
  assert.equal((await store.readArchivedConversation(archived.id, binding)).view.artifacts[0].html, 'archived');
  assert.equal((await store.loadConversation('panel')).view.artifactHistory.widget[0].html, 'old referenced revision');
});

test('unreadable or future-version snapshots abort collection without removing any assets', async () => {
  await store.saveConversation('panel', { ...binding, view: { artifacts: [{ id: 'a', html: 'keep' }] } });
  await fs.writeFile(snapshotPath('broken'), '{');
  assert.deepEqual(await store.collectUnusedConversationAssets(Date.now() + 9 * 86400_000), { removed: 0, aborted: true });
  await fs.writeFile(snapshotPath('broken'), JSON.stringify({ ...binding, storageVersion: 3 }));
  assert.deepEqual(await store.collectUnusedConversationAssets(Date.now() + 9 * 86400_000), { removed: 0, aborted: true });
  await fs.writeFile(snapshotPath('broken'), JSON.stringify({ ...binding, storageVersion: 2, view: { artifactHistory: { malformed: {} } } }));
  assert.deepEqual(await store.collectUnusedConversationAssets(Date.now() + 9 * 86400_000), { removed: 0, aborted: true });
  assert.equal((await fs.readdir(path.join(directory, 'assets'))).length, 1);
});

test('collection waits for active writes and a new save waits for collection', async t => {
  let release, started;
  const writing = new Promise(resolve => { started = resolve; });
  const original = fs.rename.bind(fs);
  let gate = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (gate && to === snapshotPath('panel')) { gate = false; started(); await new Promise(resolve => { release = resolve; }); }
    return original(from, to);
  });
  const first = store.saveConversation('panel', { ...binding, view: { artifacts: [{ id: 'a', html: 'first' }] } });
  await writing;
  const collecting = store.collectUnusedConversationAssets(Date.now() + 9 * 86400_000);
  const final = store.saveConversation('panel', { ...binding, view: { artifacts: [{ id: 'a', html: 'final' }] } });
  release(); await Promise.all([first, collecting, final]);
  assert.equal((await store.loadConversation('panel')).view.artifacts[0].html, 'final');
});

test('collection lets an active reader finish even after its snapshot was replaced', async t => {
  await store.saveConversation('panel', { ...binding, view: { artifacts: [{ id: 'a', html: 'reading' }] } });
  let started, release;
  const opening = new Promise(resolve => { started = resolve; });
  const original = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    if (args[0].includes(path.sep + 'assets' + path.sep)) { started(); await new Promise(resolve => { release = resolve; }); }
    return original(...args);
  });
  const reading = store.loadConversation('panel'); await opening;
  await store.saveConversation('panel', { ...binding, view: { artifacts: [] } });
  let collected = false;
  const cleaning = store.collectUnusedConversationAssets(Date.now() + 9 * 86400_000).then(result => { collected = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(collected, false);
  release();
  assert.equal((await reading).view.artifacts[0].html, 'reading');
  assert.deepEqual(await cleaning, { removed: 1, aborted: false });
});
