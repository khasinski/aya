import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guiCommands, guiCapabilities } from '../shared/gui-commands.cjs';
for (const agent of ['codex', 'claude', 'pi', 'antigravity']) {
  test(`${agent} advertises only the commands its GUI transport implements`, () => {
    const commands = guiCommands(agent);
    assert.ok(commands.every(command => command.name && command.description));
    assert.equal(new Set(commands.map(command => command.name)).size, commands.length);
    assert.equal(commands.some(command => command.name === 'btw'), ['codex', 'claude'].includes(agent));
    assert.equal(guiCapabilities(agent).steer, agent !== 'antigravity');
    assert.ok(!commands.some(command => /requires a completed turn/.test(command.description)));
  });
}
