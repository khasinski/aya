import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuiPanelState, matchesGuiBinding } from '../dist-electron/gui-panel-state.js';
const snapshot = { cwd: '/project', configDir: '/account-a', agent: 'codex', threadId: 'thread-a', view: { messages: [{ type: 'user', text: 'Saved' }] } };
function fixture(save) {
  const documents = [], state = new GuiPanelState(save, key => documents.push(key));
  const session = { close() { session.closed = true; } };
  state.sessions.set('1:panel', { session, cwd: snapshot.cwd, agent: 'codex' });
  state.snapshots.set('1:panel', structuredClone(snapshot));
  state.artifacts.set('1:panel', new Map([['image', { id: 'image', dataUrl: 'image-data' }]]));
  state.artifactVersions.set('1:panel', new Map([['image', [{ dataUrl: 'old-image' }]]]));
  state.attachments.set('1:panel', new Map([['file', { path: '/file' }]]));
  return { state, session, documents };
}
test('binding validation rejects a previous account, workspace or harness, including legacy Codex snapshots', () => {
  assert.equal(matchesGuiBinding(snapshot, { cwd: '/project', configDir: '/account-a', agent: 'codex' }), true);
  assert.equal(matchesGuiBinding(snapshot, { cwd: '/project', configDir: '/account-b', agent: 'codex' }), false);
  assert.equal(matchesGuiBinding(snapshot, { cwd: '/other', configDir: '/account-a', agent: 'codex' }), false);
  assert.equal(matchesGuiBinding({ ...snapshot, agent: undefined }, { cwd: '/project', configDir: '/account-a', agent: 'claude' }), false);
});
test('close saves the final draft before releasing all panel-owned memory', async () => {
  let release, saved;
  const gate = new Promise(resolve => release = resolve);
  const { state, session, documents } = fixture(async (id, value) => { saved = structuredClone({ id, value }); await gate; });
  const closing = state.close('1:panel', { prompt: 'Final unsaved draft' });
  assert.equal(session.closed, true);
  assert.equal(state.closing.has('1:panel'), true);
  assert.equal(saved.value.view.prompt, 'Final unsaved draft');
  release(); await closing;
  for (const map of [state.sessions, state.snapshots, state.attachments, state.artifacts, state.artifactVersions]) assert.equal(map.has('1:panel'), false);
  assert.deepEqual(documents, ['1:panel']);
});
test('serialized lifecycle waits for the old close before connecting a new account', async () => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  const { state } = fixture(() => gate);
  const closing = state.run('1:panel', () => state.close('1:panel'));
  let connected = false;
  const connect = state.run('1:panel', async () => { connected = true; assert.equal(state.snapshots.has('1:panel'), false); });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(connected, false);
  release(); await closing; await connect;
  assert.equal(connected, true);
});
test('save failure still releases memory and owner cleanup covers disconnected panels', async () => {
  const { state } = fixture(async () => { throw Error('Disk full'); });
  await assert.rejects(state.close('1:panel'), /Disk full/);
  assert.equal(state.snapshots.size, 0); assert.equal(state.attachments.size, 0);
  state.snapshots.set('2:failed-connect', structuredClone(snapshot));
  state.attachments.set('2:failed-connect', new Map());
  state.snapshots.set('3:other-owner', structuredClone(snapshot));
  await state.closeOwner(2);
  assert.equal(state.snapshots.has('2:failed-connect'), false);
  assert.equal(state.attachments.has('2:failed-connect'), false);
  assert.equal(state.snapshots.has('3:other-owner'), true);
});
