import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedCodexGui } from './helpers/codex-gui';
import { rmSync } from 'node:fs';

test('completion while a queued steer is pending does not send it again as a new turn', async () => {
  const seed = seedCodexGui(), app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await page.evaluate(() => {
      const state = window as unknown as { startedTurns: unknown[]; ayaGui: { onEvent: (id: string, fn: (event: { method: string; params: unknown }) => void) => void } };
      state.startedTurns = [];
      state.ayaGui.onEvent('tab-left', event => { if (event.method === 'fixture/turn') state.startedTurns.push(event.params); });
    });
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('slow-steer-wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('working');
    await prompt.fill('queued instruction'); await prompt.press('Enter');
    await gui.locator('.aya-gui-queued').getByRole('button', { name: 'Steer ↗' }).click();
    await expect(gui.locator('.aya-gui-queued').getByRole('status')).toHaveText('Sending…');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('codex-gui:event', 'tab-left', { method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } }));
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    await expect(gui.locator('.aya-gui-queued')).toHaveCount(0);
    const count = await page.evaluate(() => (window as unknown as { startedTurns: unknown[] }).startedTurns.length);
    expect(count).toBe(1);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
