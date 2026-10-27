import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { prepareSpawn } from '../dist-electron/pty-prepare.js';

const request = command => ({ ptyId: 'op-session-test', command, cwd: os.tmpdir(), cols: 80, rows: 24 });
test('opt-in wraps only the launch, retaining the real preset command', async () => {
  const prepared = await prepareSpawn(request('AYA_OP_SESSION=1 /bin/echo ok'), os.tmpdir());
  assert.ok(prepared.argv, JSON.stringify(prepared));
  assert.equal(prepared.argv[0], process.execPath);
  assert.match(prepared.argv[1], /shared\/op-session\.cjs$/);
  assert.deepEqual(prepared.argv.slice(2, 4), ['launch', '--']);
  assert.match(prepared.argv.at(-1), /AYA_OP_SESSION_BIN/);
  assert.match(prepared.command, /^AYA_OP_SESSION=1 /);
  assert.equal(prepared.env.ELECTRON_RUN_AS_NODE, '1');
});
test('ordinary and explicitly disabled presets retain their normal shell launch', async () => {
  for (const command of ['/bin/echo ok', 'AYA_OP_SESSION=0 /bin/echo ok', '/bin/echo AYA_OP_SESSION=1']) {
    const prepared = await prepareSpawn(request(command), os.tmpdir());
    assert.ok(prepared.argv);
    assert.notEqual(prepared.argv[0], process.execPath);
    assert.doesNotMatch(prepared.argv.at(-1), /AYA_OP_SESSION_BIN/);
    assert.equal(prepared.env.ELECTRON_RUN_AS_NODE, undefined);
  }
});
