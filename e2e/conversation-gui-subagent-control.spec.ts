import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { seedCodexGui } from './helpers/codex-gui';
import { mkdirSync, copyFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The fakes are CommonJS scripts without an extension: keep a stray package.json in /tmp from making them ESM. */
function commonJs<T extends { root: string }>(seed: T): T { writeFileSync(join(seed.root, 'package.json'), '{"type":"commonjs"}'); return seed; }

function seedClaudeGui() {
  const seed = seedEnv({
    singleTab: { presetId: 'gui', name: 'Claude GUI' },
    presetList: [{ id: 'gui', name: 'Claude GUI', icon: '✦', color: '', command: 'claude', agent: 'claude', interfaceMode: 'gui' }],
  });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-claude-gui.cjs'), join(bin, 'claude')); chmodSync(join(bin, 'claude'), 0o755);
  // The fake writes its subagent's command output where Claude Code does, under CLAUDE_CODE_TMPDIR.
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: join(bin, 'claude'), CLAUDE_CODE_TMPDIR: join(seed.root, 'claude-tmp') };
  return commonJs(seed);
}

test('a Claude subagent shows what its command prints and stops from its own row', async () => {
  const seed = seedClaudeGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('stoppable-agent'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('1 subagent working in the background…');
    const activity = gui.getByRole('region', { name: 'Tool activity details' });
    await gui.getByLabel('Tool activity', { exact: true }).click();
    await expect(activity).toContainText('◌ Subagent (general-purpose): Print ticks');
    // Its command's output streams into the row while it runs.
    await activity.getByText('Subagent (general-purpose): Print ticks').click();
    await expect(activity.locator('pre')).toContainText('Bash: Print ticks');
    await expect(activity.locator('pre')).toContainText('tick 3');
    await activity.getByRole('button', { name: 'Stop Subagent (general-purpose): Print ticks' }).click();
    await expect(activity).toContainText('■ Subagent (general-purpose): Print ticks');
    await expect(activity.getByRole('button', { name: /^Stop / })).toHaveCount(0);
    // Claude reports the stop in a reply of its own, and nothing is left working.
    await expect(gui.locator('article.assistant').last()).toContainText('The subagent was stopped.');
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(gui.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const printed = await activity.locator('pre').textContent();
    await page.waitForTimeout(500);
    await expect(activity.locator('pre')).toHaveText(printed ?? '');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Stop also stops a Claude background subagent after its turn ended', async () => {
  const seed = seedClaudeGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('stoppable-agent'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('1 subagent working in the background…');
    // The turn is over, but Stop stays while its subagent works.
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(gui.getByText(/working in the background/)).toHaveCount(0);
    await gui.getByLabel('Tool activity', { exact: true }).click();
    await expect(gui.getByRole('region', { name: 'Tool activity details' })).toContainText('■ Subagent (general-purpose): Print ticks');
    await expect(gui.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(gui.locator('article.assistant')).toHaveCount(1);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a new turn keeps a running background subagent: its row, its Stop and the status count', async () => {
  const seed = seedClaudeGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('stoppable-agent'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('1 subagent working in the background…');
    await prompt.fill('continue'); await prompt.press('Enter');
    await expect(gui.locator('article.assistant').last()).toContainText('Continuing where I left off.');
    await expect(turnStatus).toHaveText('1 subagent working in the background…');
    await gui.getByLabel('Tool activity', { exact: true }).click();
    const activity = gui.getByRole('region', { name: 'Tool activity details' });
    await activity.getByRole('button', { name: 'Stop Subagent (general-purpose): Print ticks' }).click();
    await expect(activity).toContainText('■ Subagent (general-purpose): Print ticks');
    await expect(activity.getByText(/Subagent \(general-purpose\): Print ticks/)).toHaveCount(1);
    await expect(turnStatus).not.toHaveText(/working in the background/);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('restarting the agent session drops its pending approvals and interrupts its background subagents', async () => {
  const seed = seedClaudeGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('background-agent'); await prompt.press('Enter');
    const approval = gui.getByRole('group', { name: 'Approval required' });
    await expect(approval).toContainText('Requested by Subagent: Read a.txt');
    await gui.getByRole('button', { name: 'Restart agent session' }).click();
    await expect(approval).toHaveCount(0);
    await expect(gui.locator('.aya-gui-settings-message').filter({ hasText: 'Agent session restarted' })).toBeVisible();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(turnStatus).not.toHaveText(/working in the background/);
    await expect(gui.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await gui.getByLabel('Tool activity', { exact: true }).click();
    await expect(gui.getByRole('region', { name: 'Tool activity details' })).toContainText('■ Subagent (Explore): Read a.txt');
    // Nothing from the old session holds the queue: a new message starts a turn.
    await prompt.fill('continue'); await prompt.press('Enter');
    await expect(gui.locator('article.assistant').last()).toContainText('Continuing where I left off.');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a Codex subagent runs while its thread works and stops from its own row', async () => {
  const seed = commonJs(seedCodexGui());
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('subagent-runs'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('1 subagent working in the background…');
    const activity = gui.getByRole('region', { name: 'Tool activity details' });
    await gui.getByLabel('Tool activity', { exact: true }).click();
    await expect(activity).toContainText('◌ Subagent: Watch the build');
    await activity.getByRole('button', { name: 'Stop Subagent: Watch the build' }).click();
    await expect(activity).toContainText('■ Subagent: Watch the build');
    await expect(turnStatus).toHaveText('Turn complete');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
