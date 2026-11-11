import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { envWithoutAya } from './helpers/env';
import { AYA, BARE_TEAM, HERMETIC_SHELL, TEAM_STATE_DIR, openTeams, teamSeed } from './helpers/team';
import { firstTerminalShown } from './helpers/terminal';

const oldPause = JSON.stringify({ id: 1, time: '2026-10-01T12:00:00Z', from: 'aya', to: 'tester', text: 'The team was paused', commit: null, delivered: true }) + '\n';
const oldRefusal = JSON.stringify({ time: '2026-10-01T12:01:00Z', from: 'tester', to: 'implementer', text: 'Continue the task', reason: 'team paused' }) + '\n';

test.use(teamSeed(BARE_TEAM, {
  seed: HERMETIC_SHELL,
  ayaHomeFiles: {
    [`${TEAM_STATE_DIR}/state.json`]: JSON.stringify({ started: true, paused: false }),
    [`${TEAM_STATE_DIR}/log.jsonl`]: oldPause,
    [`${TEAM_STATE_DIR}/refused.jsonl`]: oldRefusal,
  },
}));

test('team show agrees with the Teams window across pause and resume despite old paused messages', async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const card = (await openTeams(window)).getByTestId('team-ux-review');
  const current = () => {
    // A user-scoped read, not a borrowed identity from one of the test panes.
    const result = spawnSync(AYA, ['team', 'show', 'ux-review', '--json'], {
      env: { ...envWithoutAya(), AYA_SOCKET: join(seeded.ayaHome, 'aya.sock'), AYA_PROJECT_SLUG: 'e2e-proj' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout).status;
  };
  await expect(card.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(current()).toEqual({ state: 'running', pausedBy: null });
  await card.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect(current()).toEqual({ state: 'paused', pausedBy: 'user' });
  await card.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(current()).toEqual({ state: 'running', pausedBy: null });
});
