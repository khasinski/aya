import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function seedFanOut() {
  const seed = seedEnv({
    gitRepo: true,
    singleTab: { presetId: 'codex', name: 'Codex GUI' },
    presetList: [
      { id: 'codex', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' },
      { id: 'claude', name: 'Claude GUI', icon: '✦', color: '', command: 'claude', agent: 'claude', interfaceMode: 'gui' },
      { id: 'shell', name: 'Shell', icon: '$', color: '', command: 'cat' },
    ],
  });
  const bin = join(seed.root, 'gui-bin');
  mkdirSync(bin);
  // The fakes are CommonJS; a package.json higher up (e.g. in /tmp) must not turn them into ES modules.
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
  for (const [name, fixture] of [['codex', 'fake-codex-gui.cjs'], ['claude', 'fake-claude-gui.cjs']]) {
    copyFileSync(resolve('tests/helpers', fixture), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex'), AYA_E2E_CLAUDE_BIN: join(bin, 'claude') };
  return seed;
}

const PROMPT = 'Add a friendly greeting';

test('one prompt with an image goes to several agents, each in its own worktree, and Compare shows their branches', async () => {
  const seed = seedFanOut();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    const source = page.locator('.aya-conversation').first();
    await expect(source.locator('header').getByRole('status')).toHaveText('Ready');
    const sampleImage = (await page.screenshot()).toString('base64');
    await app.evaluate(({ clipboard, nativeImage }, sample) => {
      const image = nativeImage.createFromBuffer(Buffer.from(sample, 'base64'));
      clipboard.readImage = () => image;
    }, sampleImage);
    const composer = source.getByRole('textbox', { name: 'Message Codex' });
    await composer.fill(PROMPT);
    await composer.evaluate(node => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([1])], 'clipboard.png', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(source.locator('.aya-gui-attachments')).toContainText('clipboard-');

    await source.getByRole('button', { name: /^Conversation settings:/ }).click();
    await source.getByRole('button', { name: 'Send to several agents…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send to several agents' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Prompt')).toHaveValue(PROMPT);
    await expect(dialog.getByRole('list', { name: 'Attachments' })).toContainText('clipboard-');
    await expect(dialog.getByLabel('Starting branch or ref')).toHaveValue('feature/foo');
    // Only Conversation GUI presets can take a prompt this way.
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: 'Start agents' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'Codex GUI' }).check();
    await dialog.getByRole('checkbox', { name: 'Claude GUI' }).check();
    await expect(dialog.getByLabel('Worktree name')).toHaveValue('add-a-friendly-greeting');
    await dialog.getByLabel('Worktree name').fill('greet');
    await expect(dialog.getByTestId('fan-out-branches')).toHaveText('Creates aya/greet-codex-gui, aya/greet-claude-gui');
    await dialog.screenshot({ path: 'test-results/fan-out-dialog.png' });
    await dialog.getByRole('button', { name: 'Start 2 agents' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Started 2 agents.');
    await expect(dialog.getByRole('list', { name: 'Agents' })).toContainText('aya/greet-codex-gui');
    await expect(dialog.getByRole('list', { name: 'Agents' })).toContainText('aya/greet-claude-gui');

    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: seed.projectDir }).toString();
    expect(worktrees).toContain('branch refs/heads/aya/greet-codex-gui');
    expect(worktrees).toContain('branch refs/heads/aya/greet-claude-gui');

    // Each new pane sent the prompt by itself once its agent connected; the Codex one carried the pasted image.
    const codex = page.locator('.aya-conversation:has(textarea[aria-label="Message Codex"])').filter({ hasText: PROMPT });
    const claude = page.locator('.aya-conversation:has(textarea[aria-label="Message Claude"])');
    await expect(codex).toHaveCount(1);
    await expect(claude).toHaveCount(1);
    await expect(codex).toContainText('📎 clipboard-', { timeout: 15_000 });
    await expect(claude).toContainText(PROMPT, { timeout: 15_000 });

    // An agent's edits show up in Compare, against the shared base commit.
    const codexPath = join(seed.projectDir + '.worktrees', 'greet-codex-gui');
    writeFileSync(join(codexPath, 'greeting.txt'), 'hello from codex\n');
    await dialog.getByRole('button', { name: 'Compare' }).click();
    const compare = page.getByRole('dialog', { name: 'Compare agents' });
    await expect(compare).toBeVisible();
    await expect(compare.getByRole('tab')).toHaveCount(2);
    await expect(compare.getByRole('tab', { name: /Codex GUI/ })).toContainText('1 file');
    await expect(compare.getByRole('tab', { name: /Claude GUI/ })).toContainText('no changes');
    await expect(compare.getByRole('tabpanel')).toContainText('hello from codex');
    await compare.getByRole('tab', { name: /Claude GUI/ }).click();
    await expect(compare.getByRole('tabpanel')).toContainText('No diff available.');
    await compare.screenshot({ path: 'test-results/fan-out-compare.png' });
    await compare.getByRole('button', { name: 'Close' }).click();
    await expect(compare).toHaveCount(0);

    // Hidden panes only keep placeholders for their messages: look at each one in turn.
    const visible = page.locator('.aya-conversation:visible');
    for (const row of [page.locator('.aya-sidebar-row').filter({ hasText: 'Codex GUI' }).last(), page.locator('.aya-sidebar-row').filter({ hasText: 'Claude GUI' })]) {
      await row.click();
      await expect(visible.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete', { timeout: 15_000 });
      await expect(visible.locator('article.user')).toHaveCount(1);
      await expect(visible.locator('article.user')).toContainText(PROMPT);
      await expect(visible.locator('article.user small')).toHaveText('YOU');
    }
    // The source pane keeps its draft; nothing was sent from it.
    await page.locator('.aya-sidebar-row').filter({ hasText: 'Codex GUI' }).first().click();
    await expect(source).toBeVisible();
    await expect(source.locator('article.user')).toHaveCount(0);
    await expect(composer).toHaveValue(PROMPT);
    // The sidebar groups each pane under its worktree and shows the branch.
    await expect(page.locator('.aya-worktree-header').filter({ hasText: 'greet-codex-gui' })).toContainText('aya/greet-codex-gui');
    await expect(page.locator('.aya-worktree-header').filter({ hasText: 'greet-claude-gui' })).toContainText('aya/greet-claude-gui');

    // The panes of a run offer Compare from their own composer.
    await page.locator('.aya-sidebar-row').filter({ hasText: 'Claude GUI' }).click();
    const visibleClaude = page.locator('.aya-conversation:visible');
    await visibleClaude.getByRole('button', { name: /^Conversation settings:/ }).click();
    await visibleClaude.getByRole('button', { name: 'Compare agents…' }).click();
    await expect(page.getByRole('dialog', { name: 'Compare agents' })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a worktree that cannot be created does not stop the other agents', async () => {
  const seed = seedFanOut();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.aya-conversation').first().locator('header').getByRole('status')).toHaveText('Ready');
    // A plain file where Claude's checkout would go makes git refuse that one worktree.
    mkdirSync(seed.projectDir + '.worktrees', { recursive: true });
    writeFileSync(join(seed.projectDir + '.worktrees', 'blocked-claude-gui'), 'in the way');
    await page.getByRole('button', { name: '+ Send to several agents…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send to several agents' });
    await dialog.getByLabel('Prompt').fill('Readable C please');
    await dialog.getByRole('checkbox', { name: 'Claude GUI' }).check();
    await dialog.getByRole('checkbox', { name: 'Codex GUI' }).check();
    await dialog.getByLabel('Worktree name').fill('blocked');
    await dialog.getByRole('button', { name: 'Start 2 agents' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Started 1 agent. 1 agent could not get a worktree.');
    const results = dialog.getByRole('list', { name: 'Agents' }).getByRole('listitem');
    await expect(results.filter({ hasText: 'Claude GUI' })).toContainText(/already exists|exists/);
    await expect(results.filter({ hasText: 'Codex GUI' })).toContainText('aya/blocked-codex-gui');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    const codex = page.locator('.aya-conversation:has(textarea[aria-label="Message Codex"])').filter({ hasText: 'Answered: Readable C please' });
    await expect(codex).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.aya-conversation:has(textarea[aria-label="Message Claude"])')).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
