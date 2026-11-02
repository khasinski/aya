import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mapConcurrent } from '../dist-electron/bounded-map.js';
test('a large batch keeps process/IO concurrency bounded and preserves order', async () => {
  let active = 0, peak = 0;
  const values = await mapConcurrent(Array.from({ length: 100 }, (_, index) => index), 4, async value => {
    peak = Math.max(peak, ++active); await setImmediate(); active--; return value * 2;
  });
  assert.equal(peak, 4); assert.deepEqual(values, Array.from({ length: 100 }, (_, index) => index * 2));
});
test('empty batches launch no workers and invalid concurrency is refused', async () => {
  assert.deepEqual(await mapConcurrent([], 2, async () => assert.fail('empty')), []);
  await assert.rejects(mapConcurrent([1], 0, async () => {}), /positive integer/);
});
