import { test } from 'node:test';
import assert from 'node:assert/strict';
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
