import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedCodexGui } from './helpers/codex-gui';
import { seedEnv } from './helpers/seed';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

function seedClaudeGui(unsafeMode = false) {
  const seed = seedEnv({
    singleTab: { presetId: 'gui', name: 'Claude GUI' },
    presetList: [{ id: 'gui', name: 'Claude GUI', icon: '✦', color: '', command: 'claude', agent: 'claude', interfaceMode: 'gui', unsafeMode }],
  });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-claude-gui.cjs'), join(bin, 'claude')); chmodSync(join(bin, 'claude'), 0o755);
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: join(bin, 'claude') };
  return seed;
}

/** Records the fake agent's fixture events of the pane from now on. */
async function capture(page: Page, method: string) {
  await page.evaluate(method => {
    const state = window as unknown as { captured: Record<string, unknown[]>; ayaGui: { onEvent: (id: string, fn: (event: { method: string; params: unknown }) => void) => void } };
    state.captured ??= {};
    state.captured[method] = [];
    state.ayaGui.onEvent('tab-left', event => { if (event.method === method) state.captured[method].push(event.params); });
  }, method);
  return () => page.evaluate(method => (window as unknown as { captured: Record<string, unknown[]> }).captured[method], method);
}

test('Claude: a typed note declines the pending approval and reaches Claude as the reason', async () => {
  const seed = seedClaudeGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const approval = gui.getByRole('group', { name: 'Approval required' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const answers = await capture(page, 'fixture/permission-answer');

    // Enter with a note declines and gives Claude the reason.
    await prompt.fill('approval-note'); await prompt.press('Enter');
    await expect(approval).toContainText('rm -rf build');
    await expect(prompt).toHaveAttribute('placeholder', /decline/);
    await prompt.fill('Only delete build/tmp');
    await expect(approval.getByRole('button', { name: 'Decline with note' })).toBeVisible();
    await expect(gui.locator('.aya-gui-request-hint')).toContainText('decline with your note');
    await expect(gui.getByRole('button', { name: 'Decline with note' })).toHaveCount(2);
    await prompt.press('Enter');
    await expect(approval).toHaveCount(0);
    await expect(prompt).toHaveValue('');
    await expect(gui.locator('article.user').last()).toContainText('Only delete build/tmp');
    await expect(gui.locator('article.assistant').last()).toContainText('Declined: The user declined this tool call and said: Only delete build/tmp');
    expect(await answers()).toEqual([{ requestId: 'approve-note', behavior: 'deny', message: 'The user declined this tool call and said:\nOnly delete build/tmp' }]);

    // The card's button does the same.
    await prompt.fill('approval-note'); await prompt.press('Enter');
    await expect(approval).toBeVisible();
    await prompt.fill('Use git clean instead');
    await approval.getByRole('button', { name: 'Decline with note' }).click();
    await expect(approval).toHaveCount(0);
    await expect(gui.locator('article.assistant').last()).toContainText('Use git clean instead');

    // With an empty composer, Decline and Cmd+Backspace decline without a note, as before.
    await prompt.fill('approval'); await prompt.press('Enter');
    await expect(approval).toBeVisible();
    await expect(approval.getByRole('button', { name: 'Decline with note' })).toHaveCount(0);
    await approval.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(approval).toHaveCount(0);
    await prompt.fill('approval'); await prompt.press('Enter');
    await expect(approval).toBeVisible();
    await page.keyboard.press('Control+Backspace');
    await expect(approval).toHaveCount(0);
    await expect.poll(async () => ((await answers()) as { message: string }[]).slice(-2).map(a => a.message)).toEqual(['User declined in Aya GUI', 'User declined in Aya GUI']);

    // A subagent's request takes the note too.
    await prompt.fill('background-agent'); await prompt.press('Enter');
    await expect(approval).toContainText('Requested by Subagent: Read a.txt');
    await prompt.fill('Count lines, not bytes'); await prompt.press('Enter');
    await expect(approval).toHaveCount(0);
    await expect.poll(async () => ((await answers()) as { requestId: string; message: string }[]).at(-1)).toEqual({ requestId: 'sub-approve', behavior: 'deny', message: 'The user declined this tool call and said:\nCount lines, not bytes' });
    await expect(gui.locator('article.assistant').last()).toContainText('The subagent says hello.');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Claude: the permission mode changes mid-session, cycles with the shortcut and survives a reload', async () => {
  const seed = seedClaudeGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const settings = gui.getByRole('button', { name: /^Conversation settings:/ });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const modes = await capture(page, 'fixture/permission-mode');
    await expect(settings).toHaveAttribute('title', /Supervised/);
    await settings.click();
    const select = gui.getByRole('combobox', { name: 'Permission mode' });
    await expect(select).toHaveValue('supervised');
    await select.selectOption('auto-accept-edits');
    await expect(gui.getByRole('article', { name: 'Permission mode changed', exact: true })).toContainText('Supervised → Auto-accept edits. Applies now.');
    await page.keyboard.press('Escape');
    await prompt.click();
    await page.keyboard.press('Control+Shift+A');
    await expect(settings).toHaveAttribute('title', /· Auto$/);
    await page.keyboard.press('Control+Shift+A');
    await expect(settings).toHaveAttribute('title', /Full access/);
    await expect(gui.locator('header').getByText('Unsafe approvals', { exact: true })).toBeVisible();
    await expect.poll(modes).toEqual([{ mode: 'acceptEdits' }, { mode: 'auto' }, { mode: 'bypassPermissions' }]);
    // Claude can change its mode by itself; the pane follows.
    await prompt.fill('self-mode'); await prompt.press('Enter');
    await expect(settings).toHaveAttribute('title', /Auto-accept edits/);
    await expect(gui.locator('header').getByText('Unsafe approvals', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Control+Shift+A');
    await expect(settings).toHaveAttribute('title', /· Auto$/);
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    await page.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(settings).toHaveAttribute('title', /· Auto$/);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Claude: the preset’s unsafe approvals start the pane in Full access, which can be left and taken again', async () => {
  const seed = seedClaudeGui(true);
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const settings = gui.getByRole('button', { name: /^Conversation settings:/ });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(settings).toHaveAttribute('title', /Full access/);
    await expect(gui.locator('header').getByText('Unsafe approvals', { exact: true })).toBeVisible();
    await settings.click();
    const select = gui.getByRole('combobox', { name: 'Permission mode' });
    await select.selectOption('supervised');
    await expect(gui.locator('header').getByText('Unsafe approvals', { exact: true })).toHaveCount(0);
    await select.selectOption('full-access');
    await expect(gui.locator('header').getByText('Unsafe approvals', { exact: true })).toBeVisible();
    await expect(gui.getByRole('alert')).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Codex: a note declines, then steers the turn the decline let go on; a mode goes with the next turn', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const approval = gui.getByRole('group', { name: 'Approval required' });
    const settings = gui.getByRole('button', { name: /^Conversation settings:/ });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const approvals = await capture(page, 'fixture/approval');
    const steers = await capture(page, 'fixture/steer');
    const turns = await capture(page, 'fixture/turn');

    await prompt.fill('approval-continue'); await prompt.press('Enter');
    await expect(approval).toContainText('rm -rf build');
    await prompt.fill('Remove build/tmp only'); await prompt.press('Enter');
    await expect(approval).toHaveCount(0);
    await expect.poll(approvals).toEqual([{ decision: 'decline' }]);
    await expect.poll(async () => ((await steers()) as { input: { text: string }[] }[]).map(s => s.input[0].text)).toEqual(['Remove build/tmp only']);
    await expect(gui.locator('.aya-gui-messages')).toContainText('↳ Remove build/tmp only');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Interrupted');

    expect(((await turns()) as { input: { text: string }[] }[]).map(t => t.input[0].text)).toEqual(['approval-continue']);

    await expect(settings).toHaveAttribute('title', /Auto-accept edits/);
    await settings.click();
    await gui.getByRole('combobox', { name: 'Permission mode' }).selectOption('supervised');
    await expect(gui.getByRole('article', { name: 'Permission mode changed', exact: true })).toContainText('Applies to the next turn.');
    await page.keyboard.press('Escape');
    await prompt.fill('widgets'); await prompt.press('Enter');
    await expect.poll(async () => ((await turns()) as Record<string, unknown>[]).at(-1)).toMatchObject({ approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly' } });
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Pi and Antigravity show no permission mode', async () => {
  for (const [agent, bin, fixture, env] of [['pi', 'pi', 'tests/helpers/fake-pi-gui.cjs', 'AYA_E2E_PI_BIN'], ['antigravity', 'agy', 'tests/helpers/fake-agy-gui.cjs', 'AYA_E2E_AGY_BIN']] as const) {
    const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'GUI' }, presetList: [{ id: 'gui', name: 'GUI', icon: '✦', color: '', command: bin, agent, interfaceMode: 'gui' }] });
    const dir = join(seed.root, 'gui-bin'); mkdirSync(dir);
    copyFileSync(resolve(fixture), join(dir, bin)); chmodSync(join(dir, bin), 0o755);
    seed.launchEnv = { [env]: join(dir, bin) };
    const app = await launchApp(seed);
    try {
      const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
      await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
      await gui.getByRole('button', { name: /^Conversation settings:/ }).click();
      await expect(gui.getByRole('dialog', { name: 'Conversation settings' })).toBeVisible();
      await expect(gui.getByRole('combobox', { name: 'Permission mode' })).toHaveCount(0);
    } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
  }
});
