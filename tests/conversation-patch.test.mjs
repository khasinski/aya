import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationPatch, applyConversationPatch } from '../shared/conversation-patch.cjs';

test('a draft edit does not resend message history; streamed edits replace only their row', () => {
  const old = { prompt: '', messages: [{ id: 'a', text: 'x'.repeat(1000000) }, { id: 'b', text: 'partial' }] };
  const draft = { ...old, prompt: 'draft' };
  const patch = conversationPatch(old, draft, 4);
  assert.ok(JSON.stringify(patch).length < 200);
  assert.deepEqual(applyConversationPatch(old, patch, 4), draft);
  const next = { ...draft, messages: [old.messages[0], { id: 'b', text: 'completed' }, { id: 'c', text: 'new' }] };
  const delta = conversationPatch(draft, next, 5);
  assert.equal(delta.updates.length, 2);
  const applied = applyConversationPatch(draft, delta, 5);
  assert.deepEqual(applied, next);
  assert.equal(applied.messages[0], old.messages[0]);
  assert.throws(() => applyConversationPatch(draft, delta, 6), /base changed/);
  assert.throws(() => applyConversationPatch(draft, { ...delta, length: 1000000000, updates: [] }, 5), /Incomplete/);
});
