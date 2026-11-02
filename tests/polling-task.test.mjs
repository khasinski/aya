import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createPollingTask } from '../dist-test/polling-task.js';
test('timer and visibility bursts share one in-flight read and the next tick can refresh', async () => {
  let reads = 0, resolve;
  const values = [];
  const task = createPollingTask(() => { reads++; return new Promise(done => { resolve = done; }); }, value => values.push(value));
  for (let i = 0; i < 20; i++) task.refresh();
  await setImmediate(); assert.equal(reads, 1);
  resolve('first'); await setImmediate();
  task.refresh(); await setImmediate(); assert.equal(reads, 2);
  resolve('second'); await setImmediate();
  assert.deepEqual(values, ['first', 'second']); task.stop();
});
test('failure is handled and does not permanently block future reads', async () => {
  let reads = 0; const errors = [], values = [];
  const task = createPollingTask(async () => { if (++reads === 1) throw Error('offline'); return 'online'; }, value => values.push(value), error => errors.push(error.message));
  task.refresh(); await setImmediate(); task.refresh(); await setImmediate();
  assert.deepEqual(errors, ['offline']); assert.deepEqual(values, ['online']); task.stop();
});
test('retirement suppresses both deferred reads and late results', async () => {
  let reads = 0, resolve; const values = [];
  const neverStarted = createPollingTask(async () => { reads++; }, () => assert.fail('retired'));
  neverStarted.refresh(); neverStarted.stop(); await setImmediate(); assert.equal(reads, 0);
  const task = createPollingTask(() => new Promise(done => { resolve = done; }), value => values.push(value));
  task.refresh(); await setImmediate(); task.stop(); resolve('late'); await setImmediate();
  task.refresh(); assert.deepEqual(values, []);
});


test('retirement aborts chained work before it starts another subprocess', async () => {
  let release, expensiveReads = 0;
  const task = createPollingTask(async signal => {
    await new Promise(resolve => { release = resolve; });
    if (signal.aborted) return;
    expensiveReads++;
  }, () => assert.fail('retired task must not publish'));
  task.refresh(); await setImmediate(); task.stop(); release(); await setImmediate();
  assert.equal(expensiveReads, 0);
});
