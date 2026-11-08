import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedCodexGui } from './helpers/codex-gui';
import { rmSync } from 'node:fs';

test('steering is sent once while pending and can be retried after failure', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await page.evaluate(() => {
      const state = window as unknown as { capturedSteers: unknown[]; ayaGui: { onEvent: (id: string, fn: (event: { method: string; params: unknown }) => void) => void } };
      state.capturedSteers = [];
      state.ayaGui.onEvent('tab-left', event => { if (event.method === 'fixture/steer') state.capturedSteers.push(event.params); });
    });
    const steers = () => page.evaluate(() => (window as unknown as { capturedSteers: unknown[] }).capturedSteers.length);

    await prompt.fill('slow-steer-wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Codex is working…');
    await prompt.fill('queued steer'); await prompt.press('Enter');
    await prompt.fill('draft remains');
    const queuedSteer = gui.locator('.aya-gui-queued').getByRole('button', { name: 'Steer ↗' });
    // Both clicks occur before React commits disabled state, exercising the synchronous guard.
    await queuedSteer.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(gui.getByRole('button', { name: 'Sending…' })).toHaveCount(2);
    await expect(gui.getByRole('button', { name: 'Sending…' }).first()).toBeDisabled();
    await expect(gui.getByRole('button', { name: 'Sending…' }).last()).toBeDisabled();
    await expect.poll(steers).toBe(1);
    await expect(gui.locator('.aya-gui-queued')).toHaveCount(0);
    await expect(prompt).toHaveValue('draft remains');
    await expect(gui.getByRole('alert')).toHaveCount(0);

    await prompt.fill('reject once');
    await gui.getByRole('button', { name: 'Steer ↗' }).click();
    await expect(gui.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    await expect(gui.getByRole('alert')).toContainText('Steering was rejected');
    await expect(prompt).toHaveValue('reject once');
    await expect(gui.getByRole('button', { name: 'Steer ↗' })).toBeEnabled();
    await gui.getByRole('button', { name: 'Steer ↗' }).click();
    await expect(prompt).toHaveValue('');
    await expect.poll(steers).toBe(3);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
