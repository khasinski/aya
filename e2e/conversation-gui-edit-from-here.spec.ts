import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator } from '@playwright/test';

// The fixtures run from their .cjs paths: copied without the extension, newer Node loads them as ES modules.
const claudeBin = resolve('tests/helpers/fake-claude-gui.cjs'), codexBin = resolve('tests/helpers/fake-codex-gui.cjs');
const preset = (agent: string, name: string) => [{ id: 'gui', name, icon: '◆', color: '', command: agent, agent, interfaceMode: 'gui' as const }];

async function sendAndWait(gui: Locator, agent: string, text: string, answer: string) {
  const prompt = gui.getByRole('textbox', { name: `Message ${agent}` });
  await prompt.fill(text); await prompt.press('Enter');
  await expect(gui.locator('article.assistant').last()).toContainText(answer);
  await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
}
async function editFrom(gui: Locator, text: string) {
  const message = gui.locator('article.user', { hasText: text });
  await message.hover();
  await message.getByRole('button', { name: 'Edit from here' }).click();
}

test('Claude: Edit from here rewinds the session, reverts checkpointed files and survives a restart', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Claude GUI' }, presetList: preset('claude', 'Claude GUI') });
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: claudeBin, AYA_FAKE_CLAUDE_STATE: join(seed.root, 'claude-state.json') };
  let app = await launchApp(seed);
  try {
    let gui = (await app.firstWindow()).locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await sendAndWait(gui, 'Claude', 'note alpha', 'I remember: alpha');
    await sendAndWait(gui, 'Claude', 'write beta.txt hello', 'I remember: alpha, beta.txt');
    await sendAndWait(gui, 'Claude', 'note gamma', 'I remember: alpha, beta.txt, gamma');
    expect(readFileSync(join(seed.projectDir, 'beta.txt'), 'utf8')).toBe('hello');

    await editFrom(gui, 'write beta.txt hello');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    await expect(prompt).toHaveValue('write beta.txt hello');
    const bar = gui.getByRole('region', { name: 'Edit from here' });
    await expect(bar).toContainText('removes the 3 after it');
    const revert = bar.getByRole('checkbox', { name: 'Also revert files' });
    await expect(revert).toBeEnabled();
    await expect(bar).toContainText('Restores the file Claude changed with its edit tools');
    await revert.check();
    await prompt.fill('note delta'); await prompt.press('Enter');

    await expect(gui.locator('article.assistant').last()).toContainText('I remember: alpha, delta');
    await expect(bar).toHaveCount(0);
    await expect(gui.locator('.aya-gui-messages')).not.toContainText('gamma');
    await expect(gui.locator('article.user')).toHaveCount(2);
    expect(existsSync(join(seed.projectDir, 'beta.txt'))).toBe(false);
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');

    // The shortened conversation and the forked Claude session are what Aya restores.
    await closeAndWait(app);
    app = await launchApp(seed);
    gui = (await app.firstWindow()).locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui.locator('article.user')).toHaveCount(2);
    await expect(gui.locator('.aya-gui-messages')).not.toContainText('gamma');
    await sendAndWait(gui, 'Claude', 'note zeta', 'I remember: alpha, delta, zeta');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Claude: Enter while editing sends the edit, never a decline note for a pending subagent approval', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Claude GUI' }, presetList: preset('claude', 'Claude GUI') });
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: claudeBin, AYA_FAKE_CLAUDE_STATE: join(seed.root, 'claude-state.json') };
  const app = await launchApp(seed);
  try {
    const gui = (await app.firstWindow()).locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await sendAndWait(gui, 'Claude', 'note alpha', 'I remember: alpha');
    await sendAndWait(gui, 'Claude', 'note beta', 'I remember: alpha, beta');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    await prompt.fill('background-agent'); await prompt.press('Enter');
    const approval = gui.getByRole('group', { name: 'Approval required' });
    await expect(approval).toContainText('Requested by Subagent: Read a.txt');
    await editFrom(gui, 'note beta');
    const bar = gui.getByRole('region', { name: 'Edit from here' });
    await expect(bar).toBeVisible();
    await prompt.fill('note delta'); await prompt.press('Enter');
    // The approval is still waiting, and the edit says why it cannot go yet.
    await expect(gui.getByRole('alert')).toContainText('Stop the current turn before editing an earlier message.');
    await expect(approval).toBeVisible();
    await expect(bar).toBeVisible();
    await expect(gui.locator('.aya-gui-messages')).not.toContainText('↳ note delta');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Codex: Edit from here reverts the thread and restores the worktree from its snapshot', async () => {
  const repo = realpathSync(mkdtempSync('/tmp/aya-e2e-edit-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
  const main = join(repo, 'main'), wt = join(repo, 'wt');
  mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'readme\n'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'agent', wt);
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI', cwd: wt }, presetList: preset('codex', 'Codex GUI') });
  seed.launchEnv = { AYA_E2E_CODEX_BIN: codexBin };
  const app = await launchApp(seed);
  try {
    const gui = (await app.firstWindow()).locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await sendAndWait(gui, 'Codex', 'write one.txt 1', 'I remember: one.txt');
    await sendAndWait(gui, 'Codex', 'write two.txt 2', 'I remember: one.txt, two.txt');
    writeFileSync(join(wt, 'README.md'), 'edited by hand\n');
    await sendAndWait(gui, 'Codex', 'note three', 'I remember: one.txt, two.txt, three');

    await editFrom(gui, 'write two.txt 2');
    const bar = gui.getByRole('region', { name: 'Edit from here' });
    const revert = bar.getByRole('checkbox', { name: 'Also revert files' });
    await expect(revert).toBeEnabled();
    await expect(bar).toContainText('Restores this folder of the worktree');
    await revert.check();
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('note four'); await prompt.press('Enter');

    await expect(gui.locator('article.assistant').last()).toContainText('I remember: one.txt, four');
    await expect(gui.locator('.aya-gui-messages')).not.toContainText('three');
    expect(existsSync(join(wt, 'two.txt'))).toBe(false);
    expect(readFileSync(join(wt, 'one.txt'), 'utf8')).toBe('1');
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('readme\n');
    expect(existsSync(join(main, 'one.txt'))).toBe(false);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test('Edit from here offers no file revert outside a worktree, and Cancel keeps the conversation', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: preset('codex', 'Codex GUI') });
  seed.launchEnv = { AYA_E2E_CODEX_BIN: codexBin };
  const app = await launchApp(seed);
  try {
    const gui = (await app.firstWindow()).locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await sendAndWait(gui, 'Codex', 'note alpha', 'I remember: alpha');
    await sendAndWait(gui, 'Codex', 'note beta', 'I remember: alpha, beta');
    await editFrom(gui, 'note alpha');
    const bar = gui.getByRole('region', { name: 'Edit from here' });
    await expect(bar).toContainText('Files can be reverted only in a git worktree');
    await expect(bar.getByRole('checkbox', { name: 'Also revert files' })).toBeDisabled();
    await bar.getByRole('button', { name: 'Cancel edit' }).click();
    await expect(bar).toHaveCount(0);
    await expect(gui.locator('article.user')).toHaveCount(2);
    await sendAndWait(gui, 'Codex', 'note gamma', 'I remember: alpha, beta, gamma');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
