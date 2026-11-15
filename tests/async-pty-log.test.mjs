import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAsyncPtyLog } from '../dist-electron/async-pty-log.js';

test('async log preserves order, permissions, byte cap and rotation', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'aya-async-log-'));
  try {
    const file = join(root, 'log');
    const log = createAsyncPtyLog(file, 180);
    log.append('first', { value: 'a' }); await log.flush();
    log.append('second', { value: 'ą'.repeat(30) }); await log.flush();
    assert.equal(JSON.parse((await fs.readFile(file, 'utf8')).trim()).ev, 'second');
    assert.equal(JSON.parse((await fs.readFile(file + '.1', 'utf8')).trim()).ev, 'first');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(file + '.1')).mode & 0o777, 0o600);
    log.append('oversize', { text: 'x'.repeat(500) }); await log.flush();
    assert.ok((await fs.stat(file)).size <= 180);
    const broken = createAsyncPtyLog(root);
    broken.append('ignored'); await broken.flush();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('slow logging does not block the event loop and queued data is bounded', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'aya-async-log-'));
  const mkdir = fs.mkdir;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  fs.mkdir = async (...args) => { await blocked; return mkdir(...args); };
  try {
    const file = join(root, 'log');
    const log = createAsyncPtyLog(file, 1000);
    for (let i = 0; i < 10000; i++) log.append('event', { i });
    let ticked = false;
    await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
    assert.equal(ticked, true);
    release(); await log.flush();
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(lines.length > 0 && lines.length < 20);
    assert.deepEqual(lines.map(line => line.i), lines.map((_, i) => i));
  } finally { release(); fs.mkdir = mkdir; await fs.rm(root, { recursive: true, force: true }); }
});
