import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GuiJsonLines } from '../dist-electron/gui-json-lines.js';

test('GUI frame limits apply to each line, not a batch of valid frames', () => {
  const frames = new GuiJsonLines(16), received = [];
  frames.push('{"n":1}\n{"n":2}\n{"n":3}\n', value => received.push(value));
  assert.deepEqual(received, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('fragmented GUI frames preserve CRLF, blank lines and Unicode', () => {
  const frames = new GuiJsonLines(), received = [];
  for (const chunk of ['\n{"text":', '"żółw 🐢"}\r', '\n\n{"ok":true}\n']) frames.push(chunk, value => received.push(value));
  assert.deepEqual(received, [{ text: 'żółw 🐢' }, { ok: true }]);
});

test('GUI limits count UTF-8 bytes, including unterminated frames', () => {
  const frames = new GuiJsonLines(10);
  frames.push('"żż', () => {});
  assert.throws(() => frames.push('żżż"', () => {}), /frame exceeded/);
});

test('malformed GUI JSON stops before subsequent messages are delivered', () => {
  const frames = new GuiJsonLines(), received = [];
  assert.throws(() => frames.push('bad\n{"ok":true}\n', value => received.push(value)), /Malformed JSON/);
  assert.deepEqual(received, []);
});

test('with a handler, a malformed line is handed to it and the next lines are still read', () => {
  const skipped = [], frames = new GuiJsonLines(undefined, line => skipped.push(line)), received = [];
  frames.push('bad\n{"ok":true}\n', value => received.push(value));
  assert.deepEqual(skipped, ['bad']);
  assert.deepEqual(received, [{ ok: true }]);
  assert.throws(() => new GuiJsonLines(4, () => {}).push('"long line"', () => {}), /frame exceeded/, 'an oversized frame still ends the session');
});

test('a stray line on Claude\'s stdout does not end the conversation', async t => {
  const { ClaudeGuiSession } = await import('../dist-electron/multi-agent-gui-session.js');
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [path.resolve('tests/helpers/fake-claude-gui.cjs')]);
  t.after(() => session.close());
  const warn = console.warn, warned = []; console.warn = message => warned.push(message); t.after(() => { console.warn = warn; });
  await session.connect(process.cwd(), '');
  await session.send('stray-line');
  const end = Date.now() + 4000;
  while (!events.some(e => e.method === 'turn/completed') && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  assert.equal(events.some(e => e.method === 'aya/disconnected'), false);
  assert.equal(events.filter(e => e.method === 'item/completed').at(-1).params.item.text, 'Still connected.');
  assert.match(warned.join('\n'), /not JSON: Warning: something printed/);
});
