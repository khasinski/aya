import test from 'node:test';
import assert from 'node:assert/strict';
import { GuiRecoveryJournal } from '../dist-electron/gui-recovery-journal.js';
test('replays only unacknowledged updates in order but retains an outstanding approval', () => {
  const journal = new GuiRecoveryJournal();
  journal.record({ method: 'item/tool/requestUserInput', id: 'question', params: { questions: [] } });
  const saved = journal.record({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'saved' } });
  journal.acknowledge(saved.sequence);
  journal.record({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'after crash' } });
  assert.deepEqual(journal.replay(saved.sequence).events.map(event => event.method), ['item/agentMessage/delta', 'item/tool/requestUserInput']);
  journal.record({ method: 'aya/requestResolved', params: { id: 'question' } });
  assert.equal(journal.replay(saved.sequence).events.some(event => event.id === 'question'), false);
});
test('bounds retained text, reports gaps and keeps pending approvals across an overflow', () => {
  const journal = new GuiRecoveryJournal();
  journal.record({ method: 'approval', id: 1, params: { command: 'git status' } });
  for (let i = 0; i < 3000; i++) journal.record({ method: 'delta', params: { delta: 'x'.repeat(1024) } });
  const replay = journal.replay(0);
  assert.equal(replay.truncated, true); assert.ok(replay.events.length <= 2049);
  assert.ok(JSON.stringify(replay.events).length < 2.1 * 1024 * 1024);
  assert.equal(replay.events.at(-1).id, 1);
  journal.record({ method: 'turn/completed', params: {} });
  assert.equal(journal.replay(0).events.some(event => event.id === 1), false);
});
test('ignores acknowledgements from a previous session and does not journal artifact payloads', () => {
  const journal = new GuiRecoveryJournal();
  journal.record({ method: 'delta', params: { delta: 'new connection' } });
  journal.acknowledge(10000);
  assert.equal(journal.replay(10000).events[0].params.delta, 'new connection');
  journal.record({ method: 'aya/artifact', params: { html: 'x'.repeat(3 * 1024 * 1024) } });
  assert.equal(journal.replay(0).truncated, false); assert.equal(journal.replay(0).events.length, 1);
});
test('refuses unbounded pending requests instead of silently forgetting an approval', () => {
  const journal = new GuiRecoveryJournal();
  for (let id = 0; id < 128; id++) journal.record({ method: 'approval', id, params: {} });
  assert.throws(() => journal.record({ method: 'approval', id: 129, params: {} }), /pending approval/);
});

test('current goal and open-artifact state survive text overflow without reopening an acknowledged drawer', () => {
  const journal = new GuiRecoveryJournal();
  journal.record({ method: 'thread/goal/updated', params: { goal: { objective: 'New goal', status: 'active' } } });
  const opened = journal.record({ method: 'aya/artifact', params: { artifact: { id: 'widget' }, open: true } });
  for (let i = 0; i < 2100; i++) journal.record({ method: 'delta', params: { text: 'x' } });
  assert.equal(journal.replay(0).events.find(event => event.method === 'thread/goal/updated').params.goal.status, 'active');
  assert.equal(journal.replay(0).events.at(-1).params.artifactId, 'widget');
  assert.equal(journal.replay(opened.sequence).events.some(event => event.method === 'aya/openArtifact'), false);
});

test('connection loss remains known even after its notification was acknowledged', () => {
  const journal = new GuiRecoveryJournal();
  const disconnected = journal.record({ method: 'aya/disconnected', params: { message: 'process exited' } });
  journal.acknowledge(disconnected.sequence);
  assert.equal(journal.connectionLost, true);
  assert.equal(journal.replay(disconnected.sequence).events.length, 0);
});
