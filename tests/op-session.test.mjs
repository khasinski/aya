import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const script = path.resolve('shared/op-session.cjs');
const probe = path.resolve('tests/helpers/op-session-probe.py');

const runtimes = [process.execPath];
if (process.platform === 'darwin') runtimes.push(path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'));
for (const runtime of runtimes) {
test(`op commands reuse one terminal (${path.basename(runtime)}), with private cleanup`, { skip: process.platform === 'win32', timeout: 15000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aya-op-test-'));
  try {
    fs.writeFileSync(path.join(root, 'op'), `#!/usr/bin/env python3
import json, os, sys, subprocess
fd = os.open('/dev/tty', os.O_RDONLY)
print(json.dumps({'tty': subprocess.check_output(['/bin/ps', '-o', 'tty=', '-p', str(os.getpid())]).decode().strip(), 'args': sys.argv[1:], 'stdin': sys.stdin.read(), 'cwd': os.getcwd(), 'sessionVar': os.environ.get('AYA_OP_SESSION_TOKEN')}))
os.close(fd)
`, { mode: 0o700 });
    const result = spawnSync('python3', [probe, 'outer', runtime, script, 'launch', '--', 'python3', probe, 'agent'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: root + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 12000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout.trim());
    for (const r of output.results) {
      assert.notEqual(r.caller, output.session, 'agent command has its own tty');
      assert.equal(r.value.tty, output.session, 'real op keeps the original session tty');
      assert.deepEqual(r.value.args, ['read', 'op://test/secret']);
      assert.equal(r.value.stdin, 'stdin payload');
      assert.equal(r.value.sessionVar, null);
    }
    assert.equal(output.socketMode, 0o600);
    assert.equal(output.directoryMode, 0o700);
    assert.equal(output.unauthorized, '', 'wrong capability cannot execute op');
    assert.equal(fs.existsSync(output.directory), false, 'session shim/socket are removed with agent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

}

test('session startup refuses a pipe instead of promising shared terminal authentication', () => {
  const result = spawnSync(process.execPath, [script, 'launch', '--', 'node', '-e', ''], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must start in a terminal/);
});

test('a client with an expired session fails without falling back or retrying op', () => {
  const result = spawnSync(process.execPath, [script, 'client', 'read', 'op://test/secret'], {
    env: { ...process.env, AYA_OP_SESSION_SOCKET: '/tmp/aya-no-such-op-session', AYA_OP_SESSION_TOKEN: 'expired' }, encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disconnected; command was not retried/);
});

test('op resolution skips an inherited session shim', () => {
  const { realOp } = require('../shared/op-session.cjs');
  assert.throws(() => realOp({ PATH: '/not/a/path', AYA_OP_SESSION_BIN: '/not/a/path' }), /not installed/);
});

test('the session cannot execute commands, write files or change CLI config outside the agent sandbox', () => {
  const { readOnlyArgs } = require('../shared/op-session.cjs');
  for (const args of [
    ['run', '--', 'sh'], ['plugin', 'run', 'aws'], ['item', 'edit', 'x'],
    ['read', 'op://a/b/c', '--out-file', '/tmp/secret'], ['read', 'op://a/b/c', '-o', '/tmp/secret'],
    ['--config', '/tmp/config', 'whoami'], ['item', 'get', 'x', '--template', '/tmp/template'],
    ['read', '--', 'op://a/b/c'], ['read', 'op://a/b/c', '--account'],
  ]) assert.equal(readOnlyArgs(args), false, JSON.stringify(args));
  for (const args of [
    ['whoami'], ['read', 'op://a/b/c'], ['--account', 'work', 'read', 'op://a/b/c'],
    ['item', 'get', 'x', '--vault=Work', '--fields', 'label=password', '--reveal'],
    ['item', 'list', '--format=json'], ['--version'],
  ]) assert.equal(readOnlyArgs(args), true, JSON.stringify(args));
});
