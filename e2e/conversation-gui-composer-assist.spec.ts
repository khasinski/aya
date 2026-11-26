import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { seedCodexGui } from './helpers/codex-gui';
import { copyFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

// The fakes are copied without an extension; newer Node versions would load them as ES modules.
const commonJs = (dir: string) => writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
import { join, resolve } from 'node:path';

function seedClaudeGui() {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Claude GUI' }, presetList: [
    { id: 'gui', name: 'Claude GUI', icon: '✦', color: '', command: 'claude', agent: 'claude', interfaceMode: 'gui' },
  ] });
  const bin = join(seed.root, 'assist-test-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-claude-gui.cjs'), join(bin, 'claude'));
  chmodSync(join(bin, 'claude'), 0o755);
  commonJs(bin);
  seed.launchEnv = { AYA_E2E_CLAUDE_BIN: join(bin, 'claude') };
  return seed;
}

test('Claude: suggested next prompt, context meter, skills picker and restart', async () => {
  const seed = seedClaudeGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Claude' });
    const meter = gui.getByLabel('Context window used');
    // The meter is read once at connect, before any turn.
    await expect(meter).toHaveText('6%');
    await expect(meter).toHaveAttribute('title', 'Context: 12,000 of 200,000 tokens (6%)');
    await expect(prompt).toHaveAttribute('placeholder', 'Message Claude… (/ for commands, $ for skills)');

    await prompt.fill('suggest a change'); await prompt.press('Enter');
    await expect(gui.locator('article').filter({ hasText: 'Here is the change.' })).toBeVisible();
    await expect(meter).toHaveText('31%');
    await expect(prompt).toHaveAttribute('placeholder', 'Now run the tests');
    await prompt.press('Tab');
    await expect(prompt).toHaveValue('Now run the tests');
    await expect(prompt).toBeFocused();
    // Typing hid the suggestion; clearing the draft does not bring it back.
    await prompt.fill('');
    await expect(prompt).toHaveAttribute('placeholder', 'Message Claude… (/ for commands, $ for skills)');
    await prompt.press('Tab');
    await expect(prompt).toHaveValue('');

    // $ lists skills (not built-in commands) with descriptions; Claude runs one as /name at the start.
    await prompt.focus();
    await prompt.pressSequentially('$');
    const skills = gui.getByRole('listbox', { name: 'Skills' });
    await expect(skills.getByRole('option')).toHaveText(['/docs:writeWrite user documentation', '/fake-review [focus]Review the current change like a picky colleague']);
    await prompt.pressSequentially('fak');
    await expect(skills.getByRole('option')).toHaveCount(1);
    // Enter takes a skill only after the arrows moved through the list; Tab takes it at once.
    await prompt.press('ArrowDown');
    await expect(prompt).toHaveAttribute('aria-activedescendant', /.+/);
    await prompt.press('Enter');
    await expect(prompt).toHaveValue('/fake-review ');
    await expect(skills).toHaveCount(0);
    await prompt.pressSequentially('the diff'); await prompt.press('Enter');
    await expect(gui.locator('article').filter({ hasText: 'Skill ran: /fake-review the diff' })).toBeVisible();
    await expect(gui.getByRole('alert')).toHaveCount(0);
    // The / command menu lists skills after Aya's own commands.
    await prompt.fill('/fake');
    await expect(gui.getByRole('button', { name: '/fake-review skill' })).toBeVisible();
    await prompt.press('Tab');
    await expect(prompt).toHaveValue('/fake-review ');
    await prompt.fill('');

    // Suggestions can be turned off; the choice hides them at once.
    await gui.getByRole('button', { name: /Conversation settings/ }).click();
    await gui.getByRole('button', { name: 'Suggestions on' }).click();
    await expect(gui.getByRole('button', { name: 'Suggestions off' })).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await prompt.fill('suggest again'); await prompt.press('Enter');
    await expect(gui.locator('article').filter({ hasText: 'Here is the change.' })).toHaveCount(2);
    await page.waitForTimeout(300);
    await expect(prompt).toHaveAttribute('placeholder', 'Message Claude… (/ for commands, $ for skills)');

    // Restart stops the agent process and resumes the same conversation in a new one.
    await gui.getByRole('button', { name: 'Restart agent session' }).click();
    await expect(gui.locator('.aya-gui-settings-message').filter({ hasText: 'Agent session restarted' })).toBeVisible();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('/fake-review again'); await prompt.press('Enter');
    await expect(gui.locator('article').filter({ hasText: 'Skill ran: /fake-review again' })).toBeVisible();
    await expect(gui.locator('article.user')).toHaveCount(4);
    // A $word that only a description mentions opens no picker; with a match, Enter still sends the message as typed.
    await prompt.fill('');
    await prompt.pressSequentially('suggest $colleague');
    await expect(gui.getByRole('listbox', { name: 'Skills' })).toHaveCount(0);
    await prompt.fill('');
    await prompt.pressSequentially('suggest $fake');
    await expect(gui.getByRole('listbox', { name: 'Skills' }).getByRole('option')).toHaveCount(1);
    await prompt.press('Enter');
    await expect(gui.locator('article.user').last()).toContainText('suggest $fake');
    await expect(prompt).toHaveValue('');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Codex: sampled next prompt, token-usage meter, $skills and /restart', async () => {
  const seed = seedCodexGui();
  commonJs(join(seed.root, 'gui-bin'));
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const meter = gui.getByLabel('Context window used');
    await expect(meter).toHaveCount(0);
    await prompt.fill('context-usage'); await prompt.press('Enter');
    await expect(gui.locator('article').filter({ hasText: 'Context measured' })).toBeVisible();
    await expect(meter).toHaveText('25%');
    await expect(meter).toHaveAttribute('title', 'Context: 64,000 of 256,000 tokens (25%)');
    await expect(prompt).toHaveAttribute('placeholder', 'Run the tests next');
    await prompt.press('Tab');
    await expect(prompt).toHaveValue('Run the tests next');

    // Codex reads $name anywhere in the message; disabled skills are not offered.
    await prompt.fill('');
    await prompt.pressSequentially('please $dep');
    const skills = gui.getByRole('listbox', { name: 'Skills' });
    await expect(skills.getByRole('option')).toHaveText(['$fake-deployDeploy to staging']);
    await prompt.press('Tab');
    await expect(prompt).toHaveValue('please $fake-deploy ');
    await prompt.pressSequentially('$');
    await expect(skills.getByRole('option')).toHaveCount(2);
    await prompt.press('Escape');
    await expect(skills).toHaveCount(0);
    await expect(prompt).toHaveValue('please $fake-deploy $');

    await prompt.fill('/restart'); await prompt.press('Enter');
    await expect(gui.locator('.aya-gui-settings-message').filter({ hasText: 'Agent session restarted' })).toBeVisible();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    // The meter keeps the last reading across the restart; the next turn works in the resumed thread.
    await expect(meter).toHaveText('25%');
    await prompt.fill('$fake-deploy now'); await prompt.press('Enter');
    await expect(gui.locator('article').filter({ hasText: 'Skill ran: $fake-deploy now' })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
