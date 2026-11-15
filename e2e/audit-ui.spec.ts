import { test, expect, launchApp, closeAndWait } from './fixtures';
import { fireShortcut } from './helpers/shortcut';
import { seedEnv } from './helpers/seed';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('image source changes show errors and retry; repaired artifact revisions recover', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(resolve('tests/helpers/fake-codex-gui.cjs'))});\n`, { mode: 0o755 });
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  writeFileSync(join(seed.projectDir, 'first.png'), Buffer.from(png, 'base64'));
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const message = async (file: string) => app.evaluate(({ BrowserWindow }, file) => {
      BrowserWindow.getAllWindows()[0].webContents.send('codex-gui:event', 'tab-left', { method: 'item/completed', params: { item: { id: 'image-message', type: 'agentMessage', text: `![Workspace image](${file})` } } });
    }, file);
    writeFileSync(join(seed.projectDir, 'review.ts'), 'first line\nreview target\nlast line');
    await app.evaluate(({ BrowserWindow }, file) => {
      BrowserWindow.getAllWindows()[0].webContents.send('codex-gui:event', 'tab-left', { method: 'item/completed', params: { item: { id: 'file-link', type: 'agentMessage', text: `[Review source](${file}:2)` } } });
    }, join(seed.projectDir, 'review.ts'));
    await gui.getByRole('link', { name: 'Review source' }).click();
    const preview = page.getByRole('dialog', { name: 'Workspace file preview' });
    await expect(preview.locator('[data-selected=true]')).toContainText('review target');
    await preview.getByRole('button', { name: 'Close file preview' }).press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(gui.getByRole('link', { name: 'Review source' })).toBeFocused();
    await message(join(seed.projectDir, 'first.png'));
    const image = gui.getByRole('img', { name: 'Workspace image' });
    await expect(image).toBeVisible();
    await message(join(seed.projectDir, 'second.png'));
    await expect(image).toHaveCount(0);
    await expect(gui.getByRole('alert')).toContainText('Cannot display');
    writeFileSync(join(seed.projectDir, 'second.png'), Buffer.from(png, 'base64'));
    await gui.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(image).toBeVisible();
    const artifact = async (revision: number, data: string) => app.evaluate(({ BrowserWindow }, { revision, data }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('codex-gui:event', 'tab-left', { method: 'aya/artifact', params: { open: true, artifact: { id: 'image', kind: 'image', title: 'Versioned image', path: 'image.png', revision, dataUrl: `data:image/png;base64,${data}` } } });
    }, { revision, data });
    await artifact(1, 'invalid');
    await expect(gui.getByText('This image could not be decoded.')).toBeVisible();
    await artifact(2, png);
    await expect(gui.getByRole('img', { name: 'Versioned image' })).toBeVisible();
    await expect(gui.getByText('This image could not be decoded.')).toHaveCount(0);
    await gui.getByRole('combobox', { name: 'Artifact version' }).selectOption('1');
    await expect(gui.getByText('This image could not be decoded.')).toBeVisible();
    await gui.getByRole('combobox', { name: 'Artifact version' }).selectOption('latest');
    await expect(gui.getByRole('img', { name: 'Versioned image' })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      for (let i = 0; i < 500; i++) BrowserWindow.getAllWindows()[0].webContents.send('codex-gui:event', 'tab-left', { method: 'item/completed', params: { item: { id: `history-${i}`, type: 'agentMessage', text: `Historical row ${i}: ` + 'message body '.repeat(30) } } });
    });
    await expect(gui.locator('article.assistant').filter({ hasText: 'Historical row 499:' })).toBeVisible();
    await expect.poll(() => gui.locator('article.assistant').count()).toBeLessThan(80);
    await gui.locator('.aya-gui-messages').evaluate(node => { node.scrollTop = 0; });
    await expect(gui.locator('article.assistant').filter({ hasText: 'Historical row 0:' })).toBeVisible();
    await expect.poll(() => gui.locator('article.assistant').count()).toBeLessThan(80);
    await fireShortcut(app, 'find-in-pane');
    await gui.getByRole('searchbox', { name: 'Find in conversation' }).fill('Historical row 410:');
    await expect(gui.getByRole('status', { name: 'Find results' })).toHaveText('1 of 1');
    await expect(gui.locator('article.assistant').filter({ hasText: 'Historical row 410:' })).toBeInViewport();
    await gui.getByRole('button', { name: 'Close find', exact: true }).click();
    await expect.poll(() => gui.locator('article.assistant').count()).toBeLessThan(80);
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('is working');
    await prompt.fill('draft survives a pane error');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('codex-gui:event', 'tab-left', { method: 'turn/plan/updated', params: { plan: [{ step: { invalid: true }, status: 'pending' }] } }));
    await expect(page.getByText('Conversation could not be displayed')).toBeVisible();
    await expect(page.getByText('This window hit an error')).toHaveCount(0);
    await page.evaluate(async cwd => {
      const view = await window.ayaGui!.invoke('tab-left', 'load', { cwd, agent: 'codex' }) as Record<string, unknown>;
      await window.ayaGui!.invoke('tab-left', 'persist', { ...view, plan: [] });
    }, seed.projectDir);
    await page.getByRole('button', { name: 'Retry conversation' }).click();
    await expect(prompt).toHaveValue('draft survives a pane error');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('is working');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Interrupted');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('split separator supports keyboard resizing and limits', async ({ window }) => {
  const separator = window.getByRole('separator', { name: 'Resize panes horizontally' }).first();
  await expect(separator).toBeVisible();
  await separator.focus();
  const before = Number(await separator.getAttribute('aria-valuenow'));
  await separator.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(before + 2));
  await separator.press('Shift+ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', String(before - 8));
  await separator.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', '18');
  await separator.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', '18');
  await separator.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow', '82');
  await separator.press('ArrowLeft');
  const handle = await separator.boundingBox();
  if (!handle) throw Error('Missing separator geometry');
  await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await window.mouse.down();
  await window.mouse.move(handle.x - 100, handle.y + handle.height / 2, { steps: 5 });
  await window.mouse.up();
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeLessThan(80);
  await expect(window.locator('body')).not.toHaveClass(/aya-split-dragging/);
});
