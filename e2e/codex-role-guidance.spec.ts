import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { ARGV_DUMP_COMMAND } from './helpers/agent-bin';
import { BARE_TEAM, HERMETIC_SHELL, TEAM_STATE_DIR, openTeams, teamSeed } from './helpers/team';
import { firstTerminalShown } from './helpers/terminal';

test.use(teamSeed(BARE_TEAM, {
  presetList: [{ id: 'shell', name: 'Fake Codex', icon: '$', color: '', agent: 'codex', command: ARGV_DUMP_COMMAND }],
  assignments: { tester: 'tab-left' },
  seed: HERMETIC_SHELL,
}));

test('a Codex role notice explains compact and restart, then becomes informational after a confirmed role read', async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const recordsFile = join(seeded.ayaHome, 'pane-launch-roles.json');
  await expect.poll(() => {
    try { return Boolean(JSON.parse(readFileSync(recordsFile, 'utf8'))['tab-left']); } catch { return false; }
  }).toBe(true);
  // Reproduce a session that originally started without its later-assigned role.
  const records = JSON.parse(readFileSync(recordsFile, 'utf8'));
  records['tab-left'] = { role: null, carried: true };
  writeFileSync(recordsFile, JSON.stringify(records));
  const card = (await openTeams(window)).getByTestId('team-ux-review');
  const note = card.getByLabel('tester role note');
  await expect(note).toHaveClass(/aya-teams-role-alert/);
  await expect(note).toContainText('It can run `aya team whoami`');
  await expect(note).toContainText('Restart resumes this Codex session and does not remove this notice');
  await expect(note).toContainText('/compact shortens history; it does not add startup instructions');
  await expect(card.getByRole('button', { name: "Restart tester's pane" })).toHaveCount(0);
  // Simulate the persisted confirmation produced by whoami; no borrowed pane identity.
  const stateFile = join(seeded.ayaHome, TEAM_STATE_DIR, 'state.json');
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* New team. */ }
  writeFileSync(stateFile, JSON.stringify({ ...state, whoamiRole: { 'tab-left': 'tester' } }));
  await expect(note).toHaveClass('aya-teams-note');
  await expect(note).toContainText('has read the current role and can continue');
  await expect(note).toContainText('whoami` again after /compact or /resume');
  await expect(note).not.toContainText('⚠');
});
