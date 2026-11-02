import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LatestSnapshotWriter } from '../dist-electron/latest-snapshot-writer.js';

test('slow writes retain only the newest pending snapshot and all waiters await durability', async () => {
  const written = [], releases = [];
  const writer = new LatestSnapshotWriter(async value => { written.push(value); await new Promise(resolve => releases.push(resolve)); });
  const first = writer.save(0);
  const pending = Array.from({ length: 100 }, (_, i) => writer.save(i + 1));
  let lastSaved = false; void pending.at(-1).then(() => { lastSaved = true; });
  assert.deepEqual(written, [0]); assert.equal(lastSaved, false);
  releases.shift()(); await first; await setImmediate();
  assert.deepEqual(written, [0, 100]); assert.equal(lastSaved, false);
  releases.shift()(); await Promise.all(pending);
  assert.equal(lastSaved, true); assert.equal(writer.idle, true);
});
test('an active failure rejects its callers but does not discard the newest queued save', async () => {
  let reject;
  const written = [];
  const writer = new LatestSnapshotWriter(async value => { written.push(value); if (value === 'first') await new Promise((_, fail) => { reject = fail; }); });
  const first = assert.rejects(writer.save('first'), /disk full/);
  const old = writer.save('superseded'), last = writer.save('final');
  reject(Error('disk full')); await first; await Promise.all([old, last]);
  assert.deepEqual(written, ['first', 'final']);
});
