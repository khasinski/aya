import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GuiProtocolWriter } from '../dist-electron/gui-protocol-writer.js';
class Sink extends EventEmitter {
  writable = true; destroyed = false; writes = []; callbacks = []; accept = false;
  write(text, callback) { this.writes.push(text); this.callbacks.push(callback); return this.accept; }
}
const limits = { frameBytes: 100, queueBytes: 150, frames: 3, timeoutMs: 1000 };
test('waits for both write completion and drain, preserves frame order and bounds the queue', () => {
  const stream = new Sink(), errors = [], writer = new GuiProtocolWriter(stream, 'Agent', error => errors.push(error), limits);
  writer.write({ first: 1 }); writer.write({ second: 2 }); writer.write({ third: 3 });
  assert.equal(stream.writes.length, 1);
  assert.throws(() => writer.write({ fourth: 4 }), /queue is full/);
  stream.callbacks.shift()(); assert.equal(stream.writes.length, 1);
  stream.emit('drain'); assert.equal(stream.writes.length, 2);
  stream.emit('drain'); stream.callbacks.shift()(); assert.equal(stream.writes.length, 3);
  stream.callbacks.shift()(); stream.emit('drain');
  assert.equal(writer.pendingBytes, 0); assert.deepEqual(errors, []);
  assert.deepEqual(stream.writes.map(JSON.parse), [{ first: 1 }, { second: 2 }, { third: 3 }]);
  writer.close(); assert.equal(stream.listenerCount('drain'), 0);
});
test('enforces frame and aggregate byte budgets without queuing rejected frames', () => {
  const stream = new Sink(), writer = new GuiProtocolWriter(stream, 'Agent', assert.fail, limits);
  assert.throws(() => writer.write('x'.repeat(101)), /protocol limit/);
  writer.write('x'.repeat(80));
  assert.throws(() => writer.write('x'.repeat(80)), /queue is full/);
  assert.equal(stream.writes.length, 1); writer.close();
});
test('a stalled transport is retired once and later drain cannot deliver queued commands', async () => {
  const stream = new Sink(), errors = [], writer = new GuiProtocolWriter(stream, 'Agent', error => errors.push(error), { ...limits, timeoutMs: 10 });
  writer.write({ first: 1 }); writer.write({ stale: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(errors.length, 1); assert.match(errors[0], /communication stalled/);
  stream.callbacks.shift()(); stream.emit('drain');
  assert.equal(stream.writes.length, 1); assert.equal(writer.pendingBytes, 0);
  assert.throws(() => writer.write({ retry: true }), /disconnected/);
});
test('stream failure clears queued data and distinguishes connection loss', () => {
  const stream = new Sink(), errors = [], writer = new GuiProtocolWriter(stream, 'Agent', error => errors.push(error), limits);
  writer.write({ command: true }); stream.emit('error', Error('broken pipe'));
  assert.deepEqual(errors, ['Agent: connection lost: broken pipe']);
  assert.equal(writer.pendingBytes, 0);
});
