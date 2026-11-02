import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationSaveDelay } from '../dist-test/conversation-save-delay.js';
test('continuous 30-second output cannot postpone autosave past the five-second deadline', () => {
  for (const busy of [true, false]) {
  let lastSave = 0, scheduled = Infinity;
  const saves = [];
  for (let now = 0; now <= 30_000; now += 20) {
    if (scheduled <= now) { lastSave = scheduled; saves.push(lastSave); }
    scheduled = now + conversationSaveDelay(busy, lastSave, now);
  }
  assert.equal(saves.length, 6);
  assert.ok(saves.every((time, i) => time - (saves[i - 1] || 0) <= 5000));
  }
  assert.equal(conversationSaveDelay(true, 0, 6000), 0);
  assert.equal(conversationSaveDelay(false, 0, 6000), 0);
  assert.equal(conversationSaveDelay(false, 0, 100), 250);
});
