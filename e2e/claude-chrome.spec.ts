import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { copyFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

test('Claude GUI enables Chrome at startup and supports connection commands without sending a model prompt', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Claude GUI' }, presetList: [
    { id: 'gui', name: 'Claude GUI', icon: '✦', color: '', command: 'claude', agent: 'claude', interfaceMode: 'gui' },
  ] });
  const bin = join(seed.root, 'chrome-test-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-claude-gui.cjs'), join(bin, 'claude'));
  chmodSync(join(bin, 'claude'), 0o755);
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: join(bin, 'claude') };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const side = gui.locator('.aya-gui-side');
    await prompt.fill('/chr');
    await expect(gui.getByRole('button', { name: '/chrome', exact: true })).toBeVisible();
    for (const [command, connection] of [['/chrome', 'Connected'], ['/chrome off', 'Not connected'], ['/chrome on', 'Connected'], ['/chrome reconnect', 'Connected']]) {
      await prompt.fill(command); await prompt.press('Enter');
      await expect(side.getByRole('heading', { name: 'Claude in Chrome' })).toBeVisible();
      await expect(side).toContainText(`Connection: ${connection}`);
      await expect(side).toContainText('Browser: Test browser');
      await expect(prompt).toHaveValue('');
    }
    await expect(gui.locator('article.user')).toHaveCount(0);
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await side.getByRole('button', { name: 'Close Chrome' }).click();
    await prompt.fill('wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('is working');
    await prompt.fill('/chrome status'); await prompt.press('Enter');
    await expect(side).toContainText('Connection: Connected');
    await prompt.fill('/chrome off'); await prompt.press('Enter');
    await expect(gui.getByRole('alert')).toContainText('Stop the current turn');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('is working');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
