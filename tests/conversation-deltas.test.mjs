import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMessageDeltas, createTextDeltaBuffer } from '../dist-test/conversation-deltas.js';

test('a burst traverses long history once and retains unchanged row identities', () => {
  const history = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), text: 'Earlier message', type: 'assistant' }));
  let scheduled, renders = 0, cancellations = 0;
  let result = history;
  const buffer = createTextDeltaBuffer(deltas => { renders++; result = appendMessageDeltas(result, deltas, delta => ({ ...delta, type: 'assistant' })); }, flush => { scheduled = flush; return () => cancellations++; });
  for (let i = 0; i < 1000; i++) buffer.push('9999', 'x');
  buffer.push('new', 'hello'); buffer.push('new', ' world');
  assert.equal(renders, 0);
  scheduled();
  assert.equal(renders, 1); assert.equal(cancellations, 1);
  assert.equal(result.length, 10_001);
  assert.equal(result[0], history[0]);
  assert.equal(result[9999].text, 'Earlier message' + 'x'.repeat(1000));
  assert.equal(result[10_000].text, 'hello world');
  buffer.flush(); assert.equal(renders, 1);
});
test('finalization flushes pending text exactly once and cancels its scheduled callback', () => {
  let scheduled, cancelled = false;
  const batches = [];
  const buffer = createTextDeltaBuffer(batch => batches.push(batch), flush => { scheduled = flush; return () => { cancelled = true; }; });
  buffer.push('a', 'A'); buffer.push('b', 'B'); buffer.push('a', 'C');
  buffer.flush(); scheduled();
  assert.equal(cancelled, true);
  assert.deepEqual(batches, [[{ id: 'a', text: 'AC' }, { id: 'b', text: 'B' }]]);
  buffer.push('a', 'D'); buffer.flush();
  assert.equal(batches.length, 2);
});
