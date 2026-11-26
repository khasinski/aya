import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { seedCodexGui } from './helpers/codex-gui';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function seedClaudeGui(resetSeconds: number) {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Claude GUI' }, presetList: [
    { id: 'gui', name: 'Claude GUI', icon: '✦', color: '', command: 'claude', agent: 'claude', interfaceMode: 'gui' },
  ] });
  const bin = join(seed.root, 'limits-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-claude-gui.cjs'), join(bin, 'claude'));
  chmodSync(join(bin, 'claude'), 0o755);
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: join(bin, 'claude'), AYA_FAKE_LIMIT_RESET_S: String(resetSeconds) };
  return seed;
}

test('a Claude usage limit shows Limited; Snooze keeps it quiet until the reset and a cancelled resume sends nothing', async () => {
  const seed = seedClaudeGui(6);
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    const limited = gui.getByRole('group', { name: 'Usage limit' });
    await prompt.fill('usage-limit'); await prompt.press('Enter');
    await expect(limited).toContainText("You've hit your limit · resets 5pm");
    await expect(limited).toContainText(/The 5-hour limit resets at /);
    await expect(turnStatus).toHaveText(/^Limited · 5-hour limit resets /);
    // The limit replaces the generic failure: no error banner.
    await expect(gui.getByRole('alert')).toHaveCount(0);
    await expect(gui.getByTestId('gui-announcer')).toHaveText(/^Limited · 5-hour limit resets /);
    await expect(page).toHaveTitle('Limited — Claude GUI');
    await page.getByTitle('Open attention center').click();
    await expect(page.locator('.aya-attention-modal .aya-attention-row', { hasText: 'Claude GUI' })).toContainText('Limited');
    await page.keyboard.press('Escape');

    await limited.getByRole('button', { name: 'Resume at reset' }).click();
    await expect(turnStatus).toHaveText(/^Limited · resumes at /);
    await limited.getByRole('button', { name: 'Cancel resume' }).click();
    await limited.getByRole('button', { name: 'Snooze until reset' }).click();
    await expect(limited.getByRole('button', { name: 'Wake now' })).toBeVisible();
    await expect(limited).toContainText('Snoozed');
    await expect(page).not.toHaveTitle(/Limited/);
    await page.getByTitle('Open attention center').click();
    await expect(page.locator('.aya-attention-modal .aya-attention-row', { hasText: 'Limited' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // At the reset the pane wakes and offers to continue; nothing was sent for it.
    await expect(limited).toContainText('Usage limit reset', { timeout: 15_000 });
    await expect(turnStatus).toHaveText('Usage limit reset · ready to continue');
    await expect(gui.locator('article.user')).toHaveCount(1);
    await limited.getByRole('button', { name: 'Continue now' }).click();
    await expect(gui.locator('article.assistant').last()).toContainText('Continuing where I left off.');
    await expect(limited).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a Codex usage limit: Resume at reset survives a reload and sends "continue" at the reset', async () => {
  const seed = seedCodexGui();
  seed.launchEnv = { ...seed.launchEnv, AYA_FAKE_LIMIT_RESET_S: '8' };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    const limited = gui.getByRole('group', { name: 'Usage limit' });
    await prompt.fill('usage-limit'); await prompt.press('Enter');
    await expect(limited).toContainText("You've hit your usage limit.");
    await expect(turnStatus).toHaveText(/^Limited · 5-hour limit resets /);
    await expect(gui.getByRole('alert')).toHaveCount(0);

    await limited.getByRole('button', { name: 'Resume at reset' }).click();
    await expect(limited.getByRole('button', { name: 'Cancel resume' })).toBeVisible();
    // The schedule is saved with the conversation, so a renderer reload keeps it.
    await expect.poll(() => {
      try { return readdirSync(join(seed.ayaHome, 'conversations')).some(file => file.endsWith('.json') && readFileSync(join(seed.ayaHome, 'conversations', file), 'utf8').includes('"resumeAtReset":true')); } catch { return false; }
    }).toBe(true);
    await page.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(limited.getByRole('button', { name: 'Cancel resume' })).toBeVisible();
    await expect(gui.locator('article.user').last()).toContainText('continue', { timeout: 20_000 });
    await expect(gui.locator('article.assistant').last()).toContainText('Continuing where I left off.');
    await expect(limited).toHaveCount(0);
    await expect(turnStatus).toHaveText('Turn complete');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('tool calls can be hidden, Zen shows only your messages and final replies, and screen readers hear the turn', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    const announcer = gui.getByTestId('gui-announcer');
    const baseTitle = await page.title();

    // A turn that waits on an approval: announced, and the focused pane's status leads the window title.
    await prompt.fill('approval'); await prompt.press('Enter');
    await expect(gui.getByText('Approval required')).toBeVisible();
    await expect(announcer).toHaveText('Approval needed: echo hello');
    await expect(page).toHaveTitle('Needs approval — Codex GUI');
    await gui.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(announcer).toHaveText('Turn complete');
    await expect(page).toHaveTitle(baseTitle);

    await prompt.fill('zen-turn'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(gui.locator('article.assistant').last()).toHaveText(/Final answer/);
    await gui.locator('summary[aria-label="Tool activity"]').click();
    const activity = gui.locator('.aya-gui-activity');
    await expect(activity).toContainText('ls -la');
    await expect(activity).toContainText('cat missing.txt');

    const viewButton = gui.getByRole('button', { name: 'Conversation view' });
    await viewButton.click();
    const menu = gui.getByRole('menu', { name: 'Conversation view' });
    // The menu takes the focus on its checked item; the arrows move through it.
    await expect(menu.getByRole('menuitemradio', { name: 'Show all' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitemradio', { name: 'Hide successful' })).toBeFocused();
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitemcheckbox', { name: /Zen mode/ })).toBeFocused();
    // Escape closes it from the toggle too, and gives the focus back to the toggle.
    await viewButton.focus();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(viewButton).toBeFocused();
    await viewButton.click();
    await menu.getByRole('menuitemradio', { name: 'Hide successful' }).click();
    await expect(activity).toContainText('cat missing.txt');
    await expect(activity).not.toContainText('ls -la');
    await menu.getByRole('menuitemradio', { name: 'Hide all' }).click();
    await expect(activity).toHaveCount(0);
    await menu.getByRole('menuitemradio', { name: 'Show all' }).click();
    await expect(activity).toContainText('ls -la');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Zen: the in-between reply and the tool calls go; your messages and the final reply stay.
    await expect(gui.getByText('Let me look at the project first.')).toBeVisible();
    await prompt.focus();
    await page.keyboard.press('ControlOrMeta+Alt+KeyZ');
    await expect(gui).toHaveAttribute('data-zen', 'true');
    await expect(gui.getByText('Let me look at the project first.')).toHaveCount(0);
    await expect(activity).toHaveCount(0);
    await expect(gui.locator('article.user')).toHaveCount(2);
    await expect(gui.getByText('Final answer: the project has no missing.txt.')).toBeVisible();
    // The choice is a preference: it survives a reload.
    await expect.poll(() => {
      // Messages are stored content-addressed below the conversation file.
      try { return readdirSync(join(seed.ayaHome, 'conversations'), { recursive: true }).some(file => String(file).endsWith('.json') && readFileSync(join(seed.ayaHome, 'conversations', String(file)), 'utf8').includes('Final answer')); } catch { return false; }
    }).toBe(true);
    await page.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui).toHaveAttribute('data-zen', 'true');
    await expect(gui.getByText('Final answer: the project has no missing.txt.')).toBeVisible();
    await expect(gui.getByText('Let me look at the project first.')).toHaveCount(0);
    await gui.getByRole('button', { name: 'Conversation view' }).click();
    await gui.getByRole('menuitemcheckbox', { name: /Zen mode/ }).click();
    await expect(gui.getByText('Let me look at the project first.')).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
