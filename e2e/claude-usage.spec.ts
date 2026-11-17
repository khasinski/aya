import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { copyFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

test('Claude /usage shows native limits and session totals while idle or working, and respects dismissal', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Claude GUI' }, presetList: [
    { id: 'gui', name: 'Claude GUI', icon: '✦', color: '', command: 'claude', agent: 'claude', interfaceMode: 'gui' },
  ] });
  const bin = join(seed.root, 'usage-test-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-claude-gui.cjs'), join(bin, 'claude'));
  chmodSync(join(bin, 'claude'), 0o755);
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: join(bin, 'claude'), AYA_FAKE_USAGE_DELAY_MS: '1000' };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' }), side = gui.locator('.aya-gui-side');
    await prompt.fill('/us');
    await expect(gui.getByRole('button', { name: '/usage', exact: true })).toBeVisible();
    await prompt.fill('/usage'); await prompt.press('Enter');
    await expect(side.getByRole('heading', { name: 'Claude usage' })).toBeVisible();
    await expect(side).toContainText('5-hour window: 37.5% used');
    await expect(side).toContainText('7-day window: 80% used');
    await expect(side).toContainText('$0.1250 USD');
    await expect(side).toContainText('1,200 input');
    await expect(prompt).toHaveValue('');
    await expect(gui.locator('article.user')).toHaveCount(0);
    await side.getByRole('button', { name: 'Close Usage' }).click();
    await prompt.fill('wait'); await prompt.press('Enter');
    const turn = gui.getByRole('status', { name: 'Turn status' });
    await expect(turn).toContainText('is working');
    await prompt.fill('/usage'); await prompt.press('Enter');
    await expect(side).toContainText('37.5% used');
    await expect(turn).toContainText('is working');
    await expect(gui.locator('article.user')).toHaveCount(1);
    await side.getByRole('button', { name: 'Close Usage' }).click();
    await prompt.fill('/usage'); await prompt.press('Enter');
    await expect(side).toContainText('Checking usage…');
    await side.getByRole('button', { name: 'Close Usage' }).click();
    // Clearing the command confirms the delayed response has reached the renderer.
    await expect(prompt).toHaveValue('');
    await expect(side).toHaveCount(0);
    await prompt.fill('/usage extra'); await prompt.press('Enter');
    await expect(gui.getByRole('alert')).toContainText('Usage: /usage');
    await expect(gui.locator('article.user')).toHaveCount(1);
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
