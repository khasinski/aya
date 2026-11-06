import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedCodexGui } from './helpers/codex-gui';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('a rejected send preserves attachments in the queue when the composer has changed', async () => {
  const seed = seedCodexGui();
  const file = join(seed.projectDir, 'notes.txt');
  writeFileSync(file, 'Keep this attachment');
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog;
    }, file);
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await gui.getByRole('button', { name: 'Attach files' }).click();
    await expect(gui.locator('.aya-gui-attachments')).toContainText('notes.txt');
    await prompt.fill('delayed-reject'); await prompt.press('Enter');
    await prompt.fill('A new draft');
    await expect(gui.getByRole('alert')).toContainText('Message preserved in the paused queue');
    await expect(prompt).toHaveValue('A new draft');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('delayed-reject');
    await expect(gui.locator('.aya-gui-queued')).toContainText('notes.txt');
    await expect(gui.getByText('Queue paused')).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a queued message cannot be edited or removed while its send awaits acknowledgement', async () => {
  const seed = seedCodexGui(), app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('delay-ack'); await prompt.press('Enter');
    await prompt.fill('complete-before-ack'); await prompt.press('Enter');
    const queued = gui.getByRole('textbox', { name: 'Queued message 1' });
    await expect(queued).toHaveValue('complete-before-ack');
    await expect(gui.locator('.aya-gui-queued').getByRole('status')).toHaveText('Sending…');
    await expect(queued).toBeDisabled();
    await expect(gui.getByRole('button', { name: 'Remove queued message 1' })).toBeDisabled();
    await expect(queued).toHaveCount(0, { timeout: 10000 });
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
