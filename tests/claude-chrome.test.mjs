import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChromeCommand } from '../dist-electron/claude-chrome.js';

const status = { allowed: true, subscriber: true, wsl: false, installed: true, connected: false, enabled_by_default: true };

test('Chrome controls report actual connection state rather than assuming a successful command connected', async () => {
  const calls = [];
  const result = await claudeChromeCommand('on', async (subtype, payload) => {
    calls.push([subtype, payload]); return subtype === 'get_chrome_dialog' ? status : {};
  });
  assert.match(result.text, /Connection: Not connected/);
  assert.match(result.text, /Default for Claude CLI sessions: On/);
  assert.deepEqual(calls, [['get_chrome_dialog', undefined], ['mcp_toggle', { serverName: 'claude-in-chrome', enabled: true }], ['get_chrome_dialog', undefined]]);
});

for (const [overrides, message] of [
  [{ allowed: false }, /organization/], [{ subscriber: false }, /subscription/],
  [{ installed: false }, /Install/], [{ wsl: true }, /WSL/],
]) {
  test(`Chrome refuses unavailable access: ${Object.keys(overrides)[0]}`, async () => {
    const calls = [];
    const request = async subtype => { calls.push(subtype); return { ...status, ...overrides }; };
    await assert.rejects(claudeChromeCommand('on', request), message);
    await assert.rejects(claudeChromeCommand('reconnect', request), message);
    assert.deepEqual(calls, ['get_chrome_dialog', 'get_chrome_dialog']);
  });
}

test('Chrome reports malformed or unsupported CLI responses without pretending to be disconnected', async () => {
  await assert.rejects(claudeChromeCommand('', async () => ({})), /unsupported Chrome status/);
  await assert.rejects(claudeChromeCommand('', async () => { throw Error('Unknown control request'); }), /Unknown control request.*update Claude Code/);
  await assert.rejects(claudeChromeCommand('on', async subtype => {
    if (subtype === 'get_chrome_dialog') return status;
    throw Error('Tool access denied');
  }), /Tool access denied/);
});

test('Chrome off and reconnect use the real MCP controls and read back the result', async () => {
  for (const [action, method, payload] of [
    ['off', 'mcp_toggle', { serverName: 'claude-in-chrome', enabled: false }],
    ['reconnect', 'mcp_reconnect', { serverName: 'claude-in-chrome' }],
  ]) {
    const calls = [];
    await claudeChromeCommand(action, async (subtype, args) => { calls.push([subtype, args]); return status; });
    assert.deepEqual(calls, [['get_chrome_dialog', undefined], [method, payload], ['get_chrome_dialog', undefined]]);
  }
});
