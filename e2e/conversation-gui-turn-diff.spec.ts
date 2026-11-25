import { test, expect, launchApp, closeAndWait } from './fixtures';
import { installFakeCodexGui } from './helpers/codex-gui';
import { seedEnv } from './helpers/seed';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('a turn\'s changes, a file edit and a commit open in the diff viewer, without edits made before the turn', async () => {
  // A git project that is already dirty before the first turn (committed.txt edited, added.txt new).
  const seed = seedEnv({ gitRepo: true, singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  installFakeCodexGui(seed);
  // The fake has no extension; newer Node versions would otherwise load it as an ES module.
  writeFileSync(join(seed.root, 'gui-bin', 'package.json'), '{"type":"commonjs"}');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: seed.projectDir }).toString().trim();
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('edit-files'); await prompt.press('Enter');

    const changes = gui.getByRole('region', { name: 'Changes in this turn' });
    await expect(changes).toContainText('2 files changed · +2 −0');
    await expect(changes).toContainText('committed.txt');
    await expect(changes).toContainText('notes/turn.md');
    await changes.getByRole('button', { name: 'View changes' }).click();
    const dialog = window.getByRole('dialog', { name: 'Changes' });
    const view = dialog.locator('.aya-diff-view');
    await expect(view).toContainText('added by the turn');
    await expect(view).toContainText('Written in this turn');
    // Edits made before the turn are not part of it.
    // (twoX was written before the turn: context only, never an added or removed row.)
    await expect(view.locator('.aya-diff-view-line--del')).toHaveCount(0);
    await expect(view.locator('.aya-diff-view-line--add')).toHaveText([/added by the turn/, /Written in this turn/]);
    await expect(view).not.toContainText('brand new');
    await expect(dialog.getByRole('combobox', { name: 'Diff to show' })).toContainText('Turn 1 · 2 files changed');
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The file edit in the activity log opens the same turn, at that file, and a comment goes into the message.
    await gui.getByLabel('Tool activity', { exact: true }).click();
    await gui.locator('.aya-gui-activity-list > details > summary').filter({ hasText: 'Editing files' }).click();
    await gui.getByRole('button', { name: 'Open diff notes/turn.md' }).click();
    await expect(view).toContainText('Written in this turn');
    await dialog.getByRole('button', { name: 'Comment on notes/turn.md line 1' }).click();
    await dialog.getByRole('textbox', { name: 'Comment on this diff line' }).fill('Use a level-two heading');
    await dialog.getByRole('textbox', { name: 'Comment on this diff line' }).press('Enter');
    await expect(dialog.locator('.aya-diff-comment-note')).toHaveText('Use a level-two heading');
    await dialog.getByTestId('diff-review-send').click();
    await expect(dialog).toHaveCount(0);
    await expect(prompt).toHaveValue(/notes\/turn\.md:1[\s\S]*Use a level-two heading/);
    await prompt.fill('');

    // A commit made after the conversation began is listed with its own diff.
    git('add', 'notes/turn.md');
    git('commit', '-qm', 'Add turn notes');
    const short = git('rev-parse', '--short', 'HEAD');
    await changes.getByRole('button', { name: 'View changes' }).click();
    const picker = dialog.getByRole('combobox', { name: 'Diff to show' });
    await expect(picker.locator('optgroup[label="Commits made during this conversation"] option')).toHaveText([`${short} Add turn notes`]);
    await picker.selectOption({ label: `${short} Add turn notes` });
    await expect(view).toContainText('Written in this turn');
    await expect(view).not.toContainText('added by the turn');
    await dialog.getByRole('button', { name: 'Close changes' }).click();
    await expect(dialog).toHaveCount(0);

    // While a turn runs, its file edits show the diff so far.
    await prompt.fill('edit-files-wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Codex is working…');
    await gui.getByLabel('Tool activity', { exact: true }).click();
    await gui.locator('.aya-gui-activity-list > details > summary').filter({ hasText: 'Editing files' }).click();
    await gui.getByRole('button', { name: 'Open diff committed.txt' }).click();
    await expect(picker).toHaveValue('current');
    await expect(view).toContainText('+added by the turn');
    await expect(view).not.toContainText('notes/turn.md');
    await window.keyboard.press('Escape');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
  } finally {
    await closeAndWait(app);
  }
});
