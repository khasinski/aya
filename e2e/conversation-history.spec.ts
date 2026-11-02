import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { mkdirSync, copyFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

test('long tool activity scrolls internally while its collapse heading stays reachable', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-gui-long-session.cjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('many actions'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    await expect(gui.locator('article.assistant')).toContainText('x'.repeat(999) + 'last chunk');
    const heading = gui.getByLabel('Tool activity', { exact: true });
    await heading.click();
    const list = gui.getByRole('region', { name: 'Tool activity details' });
    await expect(list.locator(':scope > details')).toHaveCount(40);
    await list.locator(':scope > details > summary').first().click();
    const size = await list.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight, windowHeight: innerHeight }));
    expect(size.height).toBeLessThanOrEqual(size.windowHeight / 2);
    expect(size.content).toBeGreaterThan(size.height);
    await list.focus(); await window.keyboard.press('End');
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(heading).toBeInViewport();
    await heading.click(); await expect(list).toBeHidden();
    await expect(gui.getByText('Saved locally', { exact: true })).toBeVisible();
    await window.reload();
    await expect(gui.locator('article.assistant')).toContainText('x'.repeat(999) + 'last chunk');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('conversation history pages and searches older entries beyond the first hundred', async () => {
  const { createHash } = await import('node:crypto');
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-gui-long-session.cjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  const historyDir = join(seed.ayaHome, 'conversations', 'history'); mkdirSync(historyDir, { recursive: true });
  for (let i = 0; i < 105; i++) {
    const id = createHash('sha256').update('seed-' + i).digest('hex');
    writeFileSync(join(historyDir, id + '.json'), JSON.stringify({ id, cwd: seed.projectDir, agent: 'codex', threadId: `old-${i}`, title: i === 0 ? 'Oldest hidden needle' : `Saved chat ${i}`, updatedAt: 1000 + i }));
  }
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await gui.getByRole('button', { name: 'Resume a saved conversation' }).click();
    const picker = gui.getByRole('dialog', { name: 'Resume conversation' });
    await expect(picker.getByRole('button', { name: 'Load more conversations' })).toBeVisible();
    await expect(picker.getByRole('button', { name: /Oldest hidden needle/ })).toHaveCount(0);
    await picker.getByRole('button', { name: 'Load more conversations' }).click();
    await expect(picker.getByRole('button', { name: /Oldest hidden needle/ })).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Load more conversations' })).toHaveCount(0);
    await picker.getByRole('textbox', { name: 'Search conversations' }).fill('hidden needle');
    await expect(picker.locator('.aya-session-list > button')).toHaveCount(1);
    await expect(picker.getByRole('button', { name: /Oldest hidden needle/ })).toBeVisible();
    await picker.getByRole('textbox', { name: 'Search conversations' }).fill('no matching conversation');
    await expect(picker.getByText('No saved conversations match.')).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
