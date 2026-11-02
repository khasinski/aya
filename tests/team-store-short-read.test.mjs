import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TeamStore } from '../dist-electron/team-store.js';
test('short log reads preserve message IDs and the next append cursor', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aya-short-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'log.jsonl');
  await fs.writeFile(log, JSON.stringify({ id: 41, time: new Date(0).toISOString(), from: 'a', to: 'b', commit: null, text: 'message' }) + '\n');
  const open = fs.open.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === log && args[1] === 'r') {
      const read = handle.read.bind(handle);
      handle.read = (buffer, offset, length, position) => { reads++; return read(buffer, offset, Math.min(7, length), position); };
    }
    return handle;
  });
  const store = new TeamStore(directory);
  assert.deepEqual((await store.log()).map(message => message.id), [41]);
  const next = await store.append({ from: 'a', to: 'b', commit: null, text: 'next', delivered: true });
  assert.equal(next.id, 42);
  assert.ok(reads > 2);
});
