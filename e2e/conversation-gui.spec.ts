import { test, expect, launchApp, closeAndWait } from './fixtures';
import { fireShortcut } from './helpers/shortcut';
import { seedEnv } from './helpers/seed';
import { installFakeCodexGui, seedCodexGui } from './helpers/codex-gui';
import { mkdirSync, copyFileSync, chmodSync, rmSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
test('artifact picker searches without marking results seen and unread counts survive reload', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    for (let i = 0; i < 2; i++) {
      await prompt.fill('widgets'); await prompt.press('Enter');
      await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
      await expect(gui.getByRole('button', { name: `Artifacts ${i + 1}`, exact: true })).toBeVisible();
    }
    await gui.getByRole('button', { name: 'Artifacts 2', exact: true }).click();
    await expect(gui.getByRole('button', { name: 'Artifacts 1', exact: true })).toBeVisible();
    await gui.getByRole('combobox', { name: 'Selected artifact' }).click();
    await expect(gui.getByRole('listbox', { name: 'Artifacts' }).getByRole('option')).toHaveCount(2);
    await expect(gui.locator('[role=option].aya-artifact-unread')).toHaveCount(1);
    await gui.getByRole('searchbox', { name: 'Search artifacts' }).fill('Ready');
    await expect(gui.getByRole('listbox', { name: 'Artifacts' }).getByRole('option')).toHaveCount(2);
    await window.screenshot({ path: 'test-results/artifact-picker.png' });
    await expect(gui.getByRole('button', { name: 'Artifacts 1', exact: true })).toBeVisible();
    await gui.locator('[role=option].aya-artifact-unread').click();
    await expect(gui.getByRole('button', { name: 'Artifacts', exact: true })).toBeVisible();
    await gui.getByRole('button', { name: 'Artifacts', exact: true }).click();
    await prompt.fill('update-widget-closed'); await prompt.press('Enter');
    await expect(gui.getByRole('button', { name: 'Artifacts 1', exact: true })).toBeVisible();
    await expect.poll(() => {
      try { return readdirSync(join(seed.ayaHome, 'conversations')).filter(file => file.endsWith('.json')).some(file => readFileSync(join(seed.ayaHome, 'conversations', file), 'utf8').includes('Capacity planner')); } catch { return false; }
    }).toBe(true);
    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui.getByRole('button', { name: 'Artifacts 1', exact: true })).toBeVisible();
    await gui.getByRole('button', { name: 'Artifacts 1', exact: true }).click();
    // Opening the panel displays its selected updated artifact and clears only that unseen revision.
    await expect(gui.getByRole('button', { name: 'Artifacts', exact: true })).toBeVisible();
    await expect.poll(() => {
      try { return readdirSync(join(seed.ayaHome, 'conversations')).filter(file => file.endsWith('.json')).some(file => {
        const view = JSON.parse(readFileSync(join(seed.ayaHome, 'conversations', file), 'utf8')).view;
        return view?.drawer === true && view.artifacts?.length === 2 && view.artifacts.every((a: { id: string; revision?: number }) => (view.seenArtifactRevisions?.[a.id] || 0) >= (a.revision || 1));
      }); } catch { return false; }
    }).toBe(true);
    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui.getByRole('button', { name: 'Artifacts', exact: true })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a failed widget load offers retry and reloads after the preview service recovers', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await app.evaluate(({ protocol }) => {
      protocol.unhandle('aya-widget');
      protocol.handle('aya-widget', () => new Response('Preview unavailable', { status: 404 }));
    });
    await prompt.fill('html-widget'); await prompt.press('Enter');
    await expect(gui.getByRole('alert')).toContainText('Preview did not finish loading', { timeout: 10000 });
    await expect(gui.locator('iframe[title="Capacity planner"]')).toBeHidden();
    await app.evaluate(({ protocol }, root) => {
      protocol.unhandle('aya-widget');
      const require = process.getBuiltinModule('module').createRequire(root + '/package.json');
      require(root + '/dist-electron/gui-artifact-documents.js').registerWidgetProtocol();
    }, resolve('.'));
    await gui.getByRole('button', { name: 'Reload preview', exact: true }).click();
    await expect(gui.frameLocator('iframe[title="Capacity planner"]').getByRole('heading', { name: 'Team capacity' })).toBeVisible();
    await expect(gui.getByRole('alert')).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('large widget libraries persist outside the snapshot and old previews reload after cache eviction', async () => {
  test.setTimeout(120000);
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('many-widgets'); await prompt.press('Enter');
    await expect(gui.getByRole('button', { name: 'Artifacts 20', exact: true })).toBeVisible({ timeout: 60000 });
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally', { timeout: 60000 });
    await gui.getByRole('button', { name: 'Artifacts 20', exact: true }).click();
    for (let i = 0; i < 20; i++) {
      if (i) await gui.getByRole('button', { name: 'Next artifact', exact: true }).click();
      await expect(gui.frameLocator(`iframe[title="Bulk widget ${i}"]`).getByRole('heading', { name: `Widget ${i}`, exact: true })).toBeVisible();
    }
    await gui.getByRole('combobox', { name: 'Selected artifact' }).click();
    await gui.getByRole('searchbox', { name: 'Search artifacts' }).fill('Bulk widget 0');
    await gui.getByRole('listbox', { name: 'Artifacts' }).getByRole('option', { name: 'Bulk widget 0', exact: true }).click();
    await expect(gui.frameLocator('iframe[title="Bulk widget 0"]').getByRole('heading', { name: 'Widget 0', exact: true })).toBeVisible();
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally', { timeout: 60000 });
    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui.frameLocator('iframe[title="Bulk widget 0"]').getByRole('heading', { name: 'Widget 0', exact: true })).toBeVisible();
    await expect(gui.getByRole('status', { name: 'Artifact position' })).toHaveText('1 of 20');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('failed autosave stays visible after dismissing other errors and can be retried', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  let blockedFile: string | undefined, backupFile: string | undefined;
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    const snapshots = join(seed.ayaHome, 'conversations');
    blockedFile = join(snapshots, readdirSync(snapshots).find(file => file.endsWith('.json'))!);
    backupFile = blockedFile + '.backup';
    renameSync(blockedFile, backupFile); mkdirSync(blockedFile);
    await prompt.fill('/unknown'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Not saved');
    await expect(gui.locator('.aya-gui-save-state')).toContainText(/EISDIR|ENOTEMPTY|directory/);
    await gui.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(gui.getByRole('alert')).toHaveCount(0);
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Not saved');
    rmSync(blockedFile, { recursive: true, force: true }); renameSync(backupFile, blockedFile);
    await gui.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    await expect(gui.locator('.aya-gui-save-state')).not.toContainText(/EISDIR|ENOTEMPTY|directory/);
    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(prompt).toHaveValue('/unknown');
  } finally {
    if (backupFile && blockedFile && existsSync(backupFile)) { rmSync(blockedFile, { recursive: true, force: true }); renameSync(backupFile, blockedFile); }
    await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true });
  }
});

test('experimental GUI lives inside Aya with closed artifacts, approvals and explicit commands', async () => {
  const seed = seedCodexGui();
  writeFileSync(join(seed.projectDir, 'graphic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" rx="20" fill="#b9a6f7"/><text x="35" y="78" font-size="56" fill="#171124">Aya</text></svg>');
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    const gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui).toContainText('fake-codex');
    expect(await gui.locator('.aya-gui-messages').evaluate(node => getComputedStyle(node).paddingLeft)).toBe('24px');
    await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toHaveCount(0);
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('wait'); await prompt.press('Enter');
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    await expect(turnStatus).toHaveText('Codex is working…');
    await expect(turnStatus).toHaveAttribute('data-working', 'true');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(turnStatus).toHaveText('Interrupted');
    await expect(turnStatus).toHaveAttribute('data-working', 'false');
    await prompt.fill('widgets'); await prompt.press('Enter');
    await expect(gui.getByRole('button', { name: 'Artifacts 1' })).toBeVisible();
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toHaveCount(0);
    await gui.getByRole('button', { name: 'Artifacts 1' }).click();
    await expect(gui.getByRole('complementary', { name: 'Artifacts' }).getByRole('table')).toContainText('Ready');
    await gui.locator('header').getByRole('button', { name: /Artifacts/ }).click();
    await prompt.fill('open-widget'); await prompt.press('Enter');
    await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toBeVisible();
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' })).toContainText('Opened by Codex');
    await gui.locator('header').getByRole('button', { name: /Artifacts/ }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('reopen'); await prompt.press('Enter');
    await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toContainText('Opened by Codex');
    await expect(gui.getByRole('button', { name: 'Artifacts', exact: true })).toBeVisible();
    await gui.locator('header').getByRole('button', { name: /Artifacts/ }).click();
    await prompt.fill('/goal Ship the feature'); await prompt.press('Enter');
    await expect(gui.locator('.aya-gui-goal')).toContainText('Ship the feature');
    await expect(gui.getByRole('article', { name: 'Goal set', exact: true })).toHaveCount(1);
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Active');
    await gui.getByRole('button', { name: 'Pause goal', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Paused');
    await expect(gui.getByRole('article', { name: 'Goal paused', exact: true })).toHaveCount(1);
    await gui.getByRole('button', { name: 'Resume goal', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Active');
    await expect(gui.getByRole('article', { name: 'Goal resumed', exact: true })).toHaveCount(1);
    await prompt.fill('block-goal'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Blocked');
    await expect(gui.getByLabel('Goal block reason')).toContainText('staging API key is missing');
    await expect(gui.getByRole('article', { name: 'Goal blocked', exact: true })).toContainText('staging API key is missing');
    await gui.getByRole('button', { name: 'Resume goal', exact: true }).click();
    await expect(gui.getByLabel('Goal block reason')).toHaveCount(0);
    await prompt.fill('complete-goal'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Complete');
    await expect(gui.getByRole('article', { name: 'Goal completed', exact: true })).toHaveCount(1);
    await expect(gui.getByRole('button', { name: 'Pause goal', exact: true })).toHaveCount(0);
    await expect(gui.getByRole('button', { name: 'Resume goal', exact: true })).toHaveCount(0);

    await prompt.fill('/btw Explain the context'); await prompt.press('Enter');
    await expect(gui.locator('.aya-gui-side')).toContainText('A separate side answer');
    await gui.getByRole('button', { name: 'Close side question' }).click();
    await prompt.fill('/unknown'); await prompt.press('Enter');
    await expect(gui.getByRole('alert')).toContainText('Unknown GUI command');
    await expect(gui.getByRole('alert')).not.toContainText('Error invoking remote method');
    await gui.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(gui.getByRole('alert')).toHaveCount(0);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue('/unknown');
    await prompt.fill('completed-tools-wait'); await prompt.press('Enter');
    const activitySummary = gui.getByLabel('Tool activity', { exact: true });
    await expect(activitySummary).toHaveText('2 actions · 2 completedDetails');
    await expect(turnStatus).toHaveText('Codex is working…');
    await prompt.fill('/btw Explain the context'); await prompt.press('Enter');
    await expect(prompt).toHaveValue('');
    // Codex answers on a forked thread while the turn keeps running.
    await expect(gui.locator('.aya-gui-side')).toContainText('A forked side answer');
    await expect(turnStatus).toHaveText('Codex is working…');
    await gui.getByRole('button', { name: 'Close side question' }).click();
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(turnStatus).toHaveText('Interrupted');
    await expect(activitySummary).toContainText('2 completed');
    await prompt.fill('mixed-tools-wait'); await prompt.press('Enter');
    await expect(activitySummary).toContainText('3 actions · 1 running · 1 completed · 1 failed');
    await prompt.fill('/btw This question will be cancelled'); await prompt.press('Enter');
    await expect(gui.locator('.aya-gui-side')).toBeVisible();
    await prompt.press('Escape');
    await expect(gui.locator('.aya-gui-side')).toHaveCount(0);
    await activitySummary.click();
    await expect(gui.locator('.aya-gui-activity')).toContainText('npm test');
    await expect(gui.locator('.aya-gui-activity-list > details > summary').first()).toHaveCSS('font-family', /mono/i);
    // Consecutive calls of one kind read as a phase, with how long each took.
    await expect(gui.locator('.aya-gui-activity-phase').first()).toHaveText(/^Commands · 3/);
    await expect(gui.locator('.aya-gui-activity-list > details > summary .aya-gui-activity-time').first()).toHaveText(/^ · (<1s|\d+s)$/);
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(activitySummary).toContainText('3 actions · 1 completed · 1 failed · 1 interrupted');
    await expect(gui.locator('.aya-gui-side')).toHaveCount(0);
    await prompt.fill('approval-options'); await prompt.press('Enter');
    const approval = gui.locator('.aya-gui-request');
    await expect(approval.getByRole('button', { name: 'Allow for this session', exact: true })).toBeVisible();
    const allowOnce = await approval.getByRole('button', { name: 'Allow once', exact: true }).boundingBox();
    const allowSession = await approval.getByRole('button', { name: 'Allow for this session', exact: true }).boundingBox();
    expect(allowSession!.x - allowOnce!.x - allowOnce!.width).toBeGreaterThanOrEqual(8);
    await approval.getByRole('button', { name: 'Always allow: git status', exact: true }).click();
    await expect(approval).toHaveCount(0);
    await expect(turnStatus).toHaveText('Turn complete');
    await prompt.fill('approval'); await prompt.press('Enter');
    await expect(gui.getByText('Approval required')).toBeVisible();
    await expect(turnStatus).toHaveText('Waiting for your response');
    await expect(turnStatus).toHaveAttribute('data-working', 'false');
    // The same wait reaches Aya's attention pipeline, as an agent's `aya status` would.
    await window.getByTitle('Open attention center').click();
    const attention = window.locator('.aya-attention-modal');
    await expect(attention.locator('.aya-attention-row', { hasText: 'Codex GUI' })).toContainText('Approval needed');
    await window.keyboard.press('Escape');
    await gui.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui.getByText('Approval required')).toHaveCount(0);
    // The keyboard answers an approval too: Ctrl+Enter allows once, Ctrl+Backspace declines when the draft is empty.
    await prompt.fill('approval'); await prompt.press('Enter');
    await expect(gui.getByText('Approval required')).toBeVisible();
    await expect(gui.locator('.aya-gui-body form .aya-gui-request')).toHaveCount(1);
    await expect(gui.locator('.aya-gui-request-hint')).toContainText('allow once');
    await window.keyboard.press('Control+Enter');
    await expect(gui.getByText('Approval required')).toHaveCount(0);
    await expect(turnStatus).toHaveText('Turn complete');
    await prompt.fill('approval'); await prompt.press('Enter');
    await expect(gui.getByText('Approval required')).toBeVisible();
    await window.keyboard.press('Control+Backspace');
    await expect(gui.getByText('Approval required')).toHaveCount(0);
    await prompt.fill('html-widget'); await prompt.press('Enter');
    const preview = gui.frameLocator('iframe[title="Capacity planner"]');
    await expect(preview.getByRole('heading', { name: 'Team capacity' })).toBeVisible();
    await expect(preview.getByText('Isolated preview')).toBeVisible();
    await expect(gui.getByRole('textbox', { name: 'Message Codex' })).toHaveValue('');
    await preview.getByRole('button', { name: 'Four-person team' }).click();
    await expect(gui.locator('.aya-widget-suggestion')).toContainText('Explore a four-person team');
    await expect(prompt).toHaveValue('');
    await gui.getByRole('button', { name: 'Add to message' }).click();
    await expect(prompt).toHaveValue('Explore a four-person team');
    await expect(prompt).toBeFocused();
    await prompt.fill('update-widget'); await prompt.press('Enter');
    await expect(preview.getByRole('heading', { name: 'Updated capacity' })).toBeVisible();
    await expect(gui.getByRole('combobox', { name: 'Artifact version' })).toBeVisible();
    await gui.getByRole('combobox', { name: 'Artifact version' }).selectOption('1');
    await expect(preview.getByRole('heading', { name: 'Team capacity' })).toBeVisible();
    await gui.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(gui.locator('.aya-widget-source')).toContainText('ayaWidget.suggest');
    await gui.getByRole('button', { name: 'Preview', exact: true }).click();
    await gui.getByRole('combobox', { name: 'Artifact version' }).selectOption('latest');
    await gui.getByRole('button', { name: 'Expand artifacts', exact: true }).click();
    await expect(gui.locator('.aya-gui-artifacts')).toHaveClass(/expanded/);
    await gui.getByRole('button', { name: 'Reduce artifacts', exact: true }).press('Escape');
    await expect(gui.locator('.aya-gui-artifacts')).not.toHaveClass(/expanded/);
    const previewWindowPromise = app.waitForEvent('window');
    await gui.getByRole('button', { name: 'Open window ↗', exact: true }).click();
    const artifactWindow = await previewWindowPromise;
    await expect(artifactWindow.getByRole('heading', { name: 'Updated capacity' })).toHaveCount(0);
    expect(await artifactWindow.evaluate(() => typeof (window as unknown as {artifactPreview?: unknown}).artifactPreview)).toBe('object');
    artifactWindow.on('pageerror', error => console.log('Artifact preview error:', error.message));
    await expect(artifactWindow.locator('html')).toHaveAttribute('data-preview-ready', 'true');
    const externalFrame = artifactWindow.frameLocator('iframe');
    await expect(externalFrame.getByRole('heading', { name: 'Updated capacity' })).toBeVisible();
    await artifactWindow.evaluate(() => { (window as unknown as { previewEvents: unknown[] }).previewEvents = []; addEventListener('message', event => { (window as unknown as { previewEvents: unknown[] }).previewEvents.push({ type: event.data?.type, matched: event.source === document.querySelector('iframe')?.contentWindow }); }); });
    // Hidden macOS windows can consume the first pointer event during activation.
    // Exercise the real keyboard path in the separate window; inline widgets above exercise clicks.
    await externalFrame.getByRole('button', { name: 'Four-person team' }).press('Enter');
    await expect(artifactWindow.getByRole('status')).toHaveText('Suggestion ready in Aya').catch(async error => { console.log('Preview messages:', await artifactWindow.evaluate(() => (window as unknown as { previewEvents: unknown[] }).previewEvents)); throw error; });
    await expect(gui.locator('.aya-widget-suggestion')).toContainText('Explore a four-person team');
    await gui.getByRole('button', { name: 'Dismiss suggestion' }).click();
    await artifactWindow.close();
    await gui.getByRole('button', { name: 'Open in browser', exact: true }).click();
    await expect.poll(() => { try { return readFileSync(join(seed.root, 'e2e-open-external.log'), 'utf8'); } catch { return ''; } }).toMatch(/file:.*artifact-previews.*\.html/);
    await window.screenshot({ path: 'test-results/conversation-widget.png' });
    await prompt.fill('graphic'); await prompt.press('Enter');
    const graphic = gui.getByRole('img', { name: 'Aya mark' });
    await expect(graphic).toBeVisible();
    expect(await graphic.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await gui.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(gui.locator('.aya-graphic-tools')).toContainText('125%');
    await gui.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect(gui.locator('.aya-graphic-tools')).toContainText('100%');
    await expect.poll(() => {
      try { return readdirSync(join(seed.ayaHome, 'conversations')).filter(file => file.endsWith('.json')).some(file => readFileSync(join(seed.ayaHome, 'conversations', file), 'utf8').includes('Aya mark')); } catch { return false; }
    }).toBe(true);
    await window.reload();
    await expect(window.locator('.aya-conversation header').getByRole('status')).toHaveText('Ready');
    await expect(window.locator('.aya-conversation').getByRole('alert')).toHaveCount(0);
    await expect(gui.getByRole('img', { name: 'Aya mark' })).toBeVisible();
    // Intercept native menu presentation and clipboard writes so headless tests
    // exercise the real callbacks without changing the user's clipboard.
    const savedImage = join(seed.root, 'context-saved.svg');
    await app.evaluate(({ Menu, BrowserWindow, dialog }, file) => {
      const state = globalThis as unknown as { imageMenu: { label?: string; click?: () => void }[]; imageCopies: number[][]; restoreImageMenu: () => void };
      const originalMenu = Menu.buildFromTemplate, originalSave = dialog.showSaveDialog;
      const contents = BrowserWindow.getAllWindows()[0].webContents, originalCopy = contents.copyImageAt;
      state.imageCopies = [];
      contents.copyImageAt = (x, y) => { state.imageCopies.push([x, y]); };
      Menu.buildFromTemplate = items => { state.imageMenu = items as typeof state.imageMenu; return { popup() {} } as Electron.Menu; };
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      state.restoreImageMenu = () => { Menu.buildFromTemplate = originalMenu; dialog.showSaveDialog = originalSave; contents.copyImageAt = originalCopy; };
    }, savedImage);
    await gui.getByRole('img', { name: 'Aya mark' }).click({ button: 'right' });
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { imageMenu?: { label?: string }[] }).imageMenu?.map(item => item.label))).toEqual(['Copy image', 'Save image…']);
    await app.evaluate(() => (globalThis as unknown as { imageMenu: { click: () => void }[] }).imageMenu[0].click());
    expect(await app.evaluate(() => (globalThis as unknown as { imageCopies: number[][] }).imageCopies.length)).toBe(1);
    await app.evaluate(() => (globalThis as unknown as { imageMenu: { click: () => void }[] }).imageMenu[1].click());
    await expect.poll(() => { try { return readFileSync(savedImage, 'utf8'); } catch { return ''; } }).toBe(readFileSync(join(seed.projectDir, 'graphic.svg'), 'utf8'));
    await app.evaluate(() => (globalThis as unknown as { restoreImageMenu: () => void }).restoreImageMenu());
    await gui.getByRole('button', { name: 'Previous artifact' }).click();
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' })).toContainText('Capacity planner');
    await expect(gui.frameLocator('iframe[title="Capacity planner"]').getByRole('heading', { name: 'Updated capacity' })).toBeVisible();
    await gui.getByRole('button', { name: 'Next artifact' }).click();
    await expect(gui.getByRole('img', { name: 'Aya mark' })).toBeVisible();
    await gui.getByRole('combobox', { name: 'Selected artifact' }).click();
    const search = gui.getByRole('searchbox', { name: 'Search artifacts' });
    await expect(search).toBeFocused();
    await search.fill('four-person');
    await expect(gui.getByRole('listbox', { name: 'Artifacts' }).getByRole('option')).toHaveCount(1);
    await expect(gui.getByRole('listbox', { name: 'Artifacts' }).getByRole('option')).toContainText('Capacity planner');
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' })).toContainText('Aya mark');
    await search.fill('nothing-matches-this');
    await expect(gui.getByText('No matching artifacts')).toBeVisible();
    await gui.getByRole('button', { name: 'Clear artifact search', exact: true }).click();
    await expect(search).toHaveValue('');
    await search.fill('four-person'); await search.press('Enter');
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' })).toContainText('Capacity planner');
    await expect(search).toHaveCount(0);
    await gui.getByRole('combobox', { name: 'Model for next turn' }).selectOption('fake-pro');
    await gui.getByRole('combobox', { name: 'Reasoning effort' }).selectOption('high');
    await expect(gui.getByRole('article', { name: 'Model changed', exact: true })).toContainText('Fake Pro');
    await expect(gui.getByRole('article', { name: 'Reasoning effort changed', exact: true })).toContainText('Default → high');
    await prompt.fill('/model fake-pro'); await prompt.press('Enter');
    await expect(gui.getByRole('article', { name: 'Model changed', exact: true })).toHaveCount(1);
    await expect(gui.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('high');
    await prompt.fill('wait'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('Codex is working…');
    await prompt.fill('Focus on the interaction details');
    await gui.getByRole('button', { name: 'Steer ↗', exact: true }).click();
    await expect(prompt).toHaveValue('');
    await expect(gui.locator('.aya-gui-messages')).toContainText('↳ Focus on the interaction details');
    // Enter queues by default and Cmd+Enter does the opposite for one message; the toggle changes the default.
    await expect(gui.locator('.aya-gui-enter-hint')).toContainText('Enter queues · ⌘Enter steers');
    await prompt.fill('Second nudge'); await prompt.press('Meta+Enter');
    await expect(gui.locator('.aya-gui-messages')).toContainText('↳ Second nudge');
    await gui.getByRole('button', { name: /Enter while working: queue/ }).click();
    await expect(gui.locator('.aya-gui-enter-hint')).toContainText('Enter steers · ⌘Enter queues');
    await prompt.fill('Third nudge'); await prompt.press('Enter');
    await expect(gui.locator('.aya-gui-messages')).toContainText('↳ Third nudge');
    await gui.getByRole('button', { name: /Enter while working: steer/ }).click();
    await prompt.fill('widgets'); await prompt.press('Enter');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('widgets');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByText('Queue paused')).toBeVisible();
    await gui.getByRole('button', { name: 'Resume queue', exact: true }).click();
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveCount(0);
    await expect(turnStatus).toHaveText('Turn complete');

    await prompt.fill('progress'); await prompt.press('Enter');
    const progress = gui.locator('.aya-gui-messages').getByRole('progressbar', { name: 'Decompiling functions' });
    await expect(progress).toHaveCount(1);
    await expect(progress).toHaveAttribute('aria-valuenow', '10');
    await expect(progress).toHaveAttribute('aria-valuemax', '10');
    await expect(progress).toHaveAttribute('aria-valuetext', '10 of 10 · Complete');
    await expect(gui.locator('.aya-task-progress--compact')).toHaveCount(0);
    await prompt.fill('progress-wait'); await prompt.press('Enter');
    await expect(gui.locator('.aya-task-progress--compact').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
    await expect.poll(() => { try { return readdirSync(join(seed.ayaHome, 'conversations')).filter(file => file.endsWith('.json')).some(file => readFileSync(join(seed.ayaHome, 'conversations', file), 'utf8').includes('Decompiled four functions')); } catch { return false; } }).toBe(true);
    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const resumedProgress = gui.locator('.aya-gui-messages').getByRole('progressbar', { name: 'Decompiling functions' }).last();
    await expect(resumedProgress).toHaveAttribute('aria-valuenow', '4');
    await expect(resumedProgress).toHaveAttribute('aria-valuetext', '4 of 10 · Paused');
    await expect(gui.getByRole('article', { name: 'Model changed', exact: true })).toHaveCount(1);
    await expect(gui.getByRole('article', { name: 'Reasoning effort changed', exact: true })).toHaveCount(1);
    await prompt.fill('/model fake-codex'); await prompt.press('Enter');
    await expect(gui.getByRole('article', { name: 'Model changed', exact: true })).toHaveCount(2);
    await expect(gui.getByRole('article', { name: 'Model changed', exact: true }).last()).toContainText('Reasoning effort: high → Default');
    await expect(gui.locator('.aya-task-progress--compact')).toHaveCount(0);

    await window.screenshot({ path: 'test-results/conversation-gui.png' });
    await prompt.fill('/goal Start an automatic turn'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('Codex is working…');
    await prompt.fill('Focus on the automatically started turn');
    await gui.getByRole('button', { name: 'Steer ↗', exact: true }).click();
    await expect(prompt).toHaveValue('');
    await expect(gui.locator('.aya-gui-messages')).toContainText('↳ Focus on the automatically started turn');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(turnStatus).toHaveText('Interrupted');
    await prompt.fill('disconnect-approval'); await prompt.press('Enter');
    await expect(gui.locator('.aya-gui-request')).toHaveCount(1);
    await prompt.fill('Queue kept across reconnect'); await prompt.press('Enter');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('Queue kept across reconnect');
    await prompt.fill('Draft kept across reconnect');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Disconnected');
    await expect(gui.locator('.aya-gui-request')).toHaveCount(0);
    await gui.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(prompt).toHaveValue('Draft kept across reconnect');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('Queue kept across reconnect');
    if (!await gui.getByRole('complementary', { name: 'Artifacts' }).isVisible()) await gui.getByRole('button', { name: /^Artifacts/ }).click();
    await gui.getByRole('combobox', { name: 'Selected artifact' }).click();
    await gui.getByRole('searchbox', { name: 'Search artifacts' }).fill('Aya mark');
    await gui.getByRole('listbox', { name: 'Artifacts' }).getByRole('option').click();
    await expect(gui.getByRole('img', { name: 'Aya mark' })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

for (const agentSpec of [
  {
    agent: 'pi',
    label: 'Pi',
    badge: 'PI',
    binName: 'pi',
    envKey: 'AYA_E2E_PI_BIN',
    fixtureFile: 'tests/helpers/fake-pi-gui.cjs',
    expectedModel: 'fake-pi',
    openedTitle: 'Opened by Pi',
    sideAnswer: 'A separate side answer from Pi',
  },
  {
    agent: 'claude',
    label: 'Claude',
    badge: 'CLAUDE',
    binName: 'claude',
    envKey: 'AYA_E2E_CLAUDE_BIN',
    fixtureFile: 'tests/helpers/fake-claude-gui.cjs',
    expectedModel: 'fake-claude',
    openedTitle: 'Opened by Claude',
    sideAnswer: 'A separate side answer from Claude',
  },
  {
    agent: 'antigravity',
    label: 'Antigravity',
    badge: 'ANTIGRAVITY',
    binName: 'agy',
    envKey: 'AYA_E2E_AGY_BIN',
    fixtureFile: 'tests/helpers/fake-agy-gui.cjs',
    expectedModel: 'fake-agy',
    openedTitle: 'Opened by Antigravity',
    sideAnswer: 'A separate side answer from Antigravity',
  },
]) {
  test(`experimental GUI supports ${agentSpec.label} (${agentSpec.agent}) with artifacts, approvals, goals and side questions`, async () => {
    const seed = seedEnv({
      singleTab: { presetId: 'gui', name: `${agentSpec.label} GUI` },
      presetList: [
        {
          id: 'gui',
          name: `${agentSpec.label} GUI`,
          icon: '✦',
          color: '',
          command: agentSpec.binName,
          agent: agentSpec.agent,
          interfaceMode: 'gui',
        },
      ],
    });
    const bin = join(seed.root, 'gui-bin');
    mkdirSync(bin);
    copyFileSync(resolve(agentSpec.fixtureFile), join(bin, agentSpec.binName));
    chmodSync(join(bin, agentSpec.binName), 0o755);
    seed.launchEnv = { [agentSpec.envKey]: join(bin, agentSpec.binName) };
    const app = await launchApp(seed);
    try {
      const window = await app.firstWindow();
      const gui = window.locator('.aya-conversation');
      await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
      await expect(gui).toContainText(agentSpec.expectedModel);
      await expect(gui.locator('.aya-gui-welcome')).toContainText(`Your ${agentSpec.label}, with room to show more.`);

      const prompt = gui.getByRole('textbox', { name: `Message ${agentSpec.label}` });
      const turnStatus = gui.getByRole('status', { name: 'Turn status' });

      await prompt.fill('open-widget');
      await prompt.press('Enter');
      await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toBeVisible();
      await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toContainText(agentSpec.openedTitle);
      await expect(turnStatus).toHaveText('Turn complete');
      await expect(gui.locator('.aya-gui-messages')).toContainText(agentSpec.badge);

      await prompt.fill('approval');
      await prompt.press('Enter');
      if (agentSpec.agent === 'antigravity') {
        await expect(turnStatus).toHaveText('Turn failed');
        await expect(gui.getByRole('alert')).toContainText('headless protocol cannot prompt');
        await expect(gui.getByText('Approval required')).toHaveCount(0);
      } else {
        await expect(gui.getByText('Approval required')).toBeVisible();
        await gui.getByRole('button', { name: 'Decline', exact: true }).click();
      }
      await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');

      await prompt.fill('/goal Deliver multi-agent GUI');
      await prompt.press('Enter');
      await expect(gui.locator('.aya-gui-goal')).toContainText('Deliver multi-agent GUI');
      await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Active');

      await prompt.fill('/');
      await expect(gui.locator('.aya-gui-commands').getByRole('button', { name: '/btw', exact: true })).toHaveCount(agentSpec.agent === 'claude' ? 1 : 0);
      await prompt.fill('/help'); await prompt.press('Enter');
      if (agentSpec.agent === 'claude') await expect(gui.locator('.aya-gui-side')).toContainText('/btw');
      else await expect(gui.locator('.aya-gui-side')).not.toContainText('/btw');
      await gui.getByRole('button', { name: 'Close side question' }).click();
      await prompt.fill('/btw Quick check');
      await prompt.press('Enter');
      if (agentSpec.agent === 'pi' || agentSpec.agent === 'antigravity') await expect(gui.getByRole('alert')).toContainText(`${agentSpec.label} does not support side questions`);
      else await expect(gui.locator('.aya-gui-side')).toContainText(agentSpec.sideAnswer);
    } finally {
      await closeAndWait(app);
      rmSync(seed.root, { recursive: true, force: true });
    }
  });
}


test('resume picker preserves drafts and artifacts, imports native history and survives delayed send acknowledgement', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('delay-ack'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Codex is working…');
    await prompt.fill('Next draft stays here');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    await expect(prompt).toHaveValue('Next draft stays here');
    await prompt.fill('widgets'); await prompt.press('Enter');
    await expect(gui.getByRole('button', { name: 'Artifacts 1' })).toBeVisible();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('Draft saved with the first conversation');
    await gui.getByRole('button', { name: 'Resume a saved conversation' }).click();
    const picker = gui.getByRole('dialog', { name: 'Resume conversation' });
    await expect(picker.getByRole('button', { name: /delay-ack/ })).toBeDisabled();
    await picker.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(prompt).toHaveValue('');
    await expect(gui.getByRole('button', { name: 'Artifacts', exact: true })).toBeVisible();
    await prompt.fill('/resume delay'); await prompt.press('Enter');
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('textbox', { name: 'Search conversations' })).toHaveValue('delay');
    await picker.getByRole('button', { name: /delay-ack/ }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(prompt).toHaveValue('Draft saved with the first conversation');
    await expect(gui.getByRole('button', { name: 'Artifacts 1' })).toBeVisible();
    await gui.getByRole('button', { name: 'Resume a saved conversation' }).click();
    await picker.getByRole('textbox', { name: 'Search conversations' }).fill('Native');
    await expect(picker).toHaveCSS('opacity', '1');
    await page.screenshot({ path: 'test-results/conversation-resume.png', animations: 'disabled' });
    await picker.getByRole('button', { name: /Native CLI conversation/ }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui).toContainText('A question from the CLI');
    await expect(gui).toContainText('An answer from the CLI');
    await expect(gui).toContainText('original tool configuration');
    await prompt.fill('/help'); await prompt.press('Enter');
    await expect(gui.locator('.aya-gui-side')).toContainText('Available commands');
    const bindingCheck = await page.evaluate(async cwd => {
      const api = (window as unknown as { ayaGui: { invoke(id: string, action: string, value?: unknown): Promise<unknown>; onEvent(id: string, callback: (event: { method: string; params: Record<string, unknown> }) => void): () => void } }).ayaGui;
      const id = 'binding-regression', events: Record<string, unknown>[] = [];
      const off = api.onEvent(id, event => { if (event.method === 'fixture/config') events.push(event.params); });
      try {
        await api.invoke(id, 'connect', { cwd, configDir: cwd + '/account-a', agent: 'codex' });
        await api.invoke(id, 'persist', { messages: [{ type: 'user', text: 'Old account context' }] });
        await api.invoke(id, 'close');
        const loaded = await api.invoke(id, 'load', { cwd, configDir: cwd + '/account-b', agent: 'codex' });
        await api.invoke(id, 'connect', { cwd, configDir: cwd + '/account-b', agent: 'codex' });
        await api.invoke(id, 'close');
        let latePersistRejected = false;
        try { await api.invoke(id, 'persist', { prompt: 'Late save after close' }); } catch { latePersistRejected = true; }
        return { loaded, resumedPreviousAccount: events.some(event => !!event.threadId), latePersistRejected };
      } finally { off(); await api.invoke(id, 'close'); }
    }, seed.projectDir);
    expect(bindingCheck).toEqual({ loaded: null, resumedPreviousAccount: false, latePersistRejected: true });

  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('GUI keeps consistent controls and follows streaming only while reading the latest messages', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    const gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const viewport = gui.locator('.aya-gui-messages');
    const bottomGap = () => viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
    const historyButton = gui.getByRole('button', { name: 'Resume a saved conversation' });
    for (const button of [historyButton, gui.getByRole('button', { name: 'Artifacts', exact: true }), gui.getByRole('button', { name: 'Attach files', exact: true })]) {
      const box = await button.boundingBox();
      expect(box?.width).toBe(32);
      expect(box?.height).toBe(32);
      await expect(button.locator('.aya-gui-icon')).toHaveCSS('font-size', '18px');
    }
    await expect(gui.locator('.aya-gui-compose-footer select').first()).toHaveCSS('height', '32px');
    await expect(prompt).toHaveCSS('font-size', '14px');
    await prompt.fill('long-stream'); await prompt.press('Enter');
    await expect(gui.locator('article.assistant')).toContainText('Paragraph 30:');
    await expect.poll(bottomGap).toBeLessThan(3);
    await expect(gui.locator('article.assistant')).toHaveCSS('font-size', '14px');
    // Reading older text must not be interrupted by incoming chunks.
    await viewport.evaluate(node => { node.scrollTop = 0; });
    await expect(gui.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    await expect(gui.locator('article.assistant')).toContainText('Paragraph 60:');
    expect(await viewport.evaluate(node => node.scrollTop)).toBe(0);
    await gui.getByRole('button', { name: 'Jump to latest' }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    await expect.poll(bottomGap).toBeLessThan(3);
    // Resizing the reading surface (opening artifacts) keeps the latest text visible.
    await gui.locator('header').getByRole('button', { name: 'Artifacts' }).click();
    const emptyPanel = gui.getByRole('complementary', { name: 'Artifacts' });
    await expect(emptyPanel.getByRole('heading', { name: 'No artifacts yet' })).toBeVisible();
    const titleBox = await emptyPanel.locator('h3').boundingBox();
    const descriptionBox = await emptyPanel.locator('p').boundingBox();
    expect(descriptionBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height);
    await expect(emptyPanel.locator('h3')).toHaveCSS('font-size', '14px');
    await expect(emptyPanel.locator('p')).toHaveCSS('font-size', '12px');
    await expect.poll(bottomGap).toBeLessThan(3);
    await gui.locator('header').getByRole('button', { name: 'Artifacts' }).click();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a queued message does not pull the reader away from earlier history', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const viewport = gui.locator('.aya-gui-messages');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('long-stream'); await prompt.press('Enter');
    await expect(gui.locator('article.assistant')).toContainText('Paragraph 30:');
    await viewport.evaluate(node => { node.scrollTop = 0; });
    await expect(gui.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    await prompt.fill('queued request'); await prompt.press('Enter');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('queued request');
    await expect(gui.locator('article.user').last()).toContainText('queued request', { timeout: 15000 });
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete', { timeout: 15000 });
    expect(await viewport.evaluate(node => node.scrollTop)).toBeLessThan(3);
    await expect(gui.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a subagent turn does not interrupt the conversation or misdirect steering', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('foreign-agent-turn'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('working');
    await expect(gui.getByText('Private child output')).toHaveCount(0);
    await prompt.fill('Stay on the main task');
    await gui.getByRole('button', { name: /Steer/ }).click();
    await expect(gui.locator('article.user').last()).toContainText('Stay on the main task');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Interrupted');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a queued message starts after a turn completes before its start acknowledgement', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('complete-before-ack'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('working');
    await prompt.fill('queued after early completion'); await prompt.press('Enter');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('queued after early completion');
    await prompt.fill('second queued message'); await prompt.press('Enter');
    await expect(gui.getByRole('textbox', { name: 'Queued message 2' })).toHaveValue('second queued message');
    await expect(gui.locator('article.user')).toHaveCount(3, { timeout: 8000 });
    await expect(gui.locator('article.user').nth(1)).toContainText('queued after early completion');
    await expect(gui.locator('article.user').nth(2)).toContainText('second queued message');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveCount(0);
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a rejected message leaves a newly started automatic turn controllable', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('reject-with-automatic-turn'); await prompt.press('Enter');
    await expect(gui.getByRole('alert')).toContainText('An automatic turn is already active');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('working');
    await expect(prompt).toHaveValue('reject-with-automatic-turn');
    await prompt.fill('Stay on this turn');
    await gui.getByRole('button', { name: /Steer/ }).click();
    await expect(gui.locator('article.user').last()).toContainText('Stay on this turn');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Interrupted');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a resumed turn stays controllable when subagent events arrive before resume acknowledgement', async () => {
  const seed = seedCodexGui();
  const snapshots = join(seed.ayaHome, 'conversations'); mkdirSync(snapshots, { recursive: true });
  const name = createHash('sha256').update(seed.tabIds.left).digest('hex') + '.json';
  writeFileSync(join(snapshots, name), JSON.stringify({ cwd: seed.projectDir, agent: 'codex', threadId: 'resuming-main', view: { messages: [{ id: 'old', type: 'user', text: 'Previous task' }] } }));
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toContainText('working');
    await prompt.fill('Continue the resumed task');
    await gui.getByRole('button', { name: /Steer/ }).click();
    await expect(gui.locator('article.user').last()).toContainText('Continue the resumed task');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Interrupted');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('sync and async harness questions support option selection, custom notes and reload persistence', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    const gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });

    await prompt.fill('question'); await prompt.press('Enter');
    const syncQuestion = gui.locator('.aya-gui-request.aya-gui-question-card');
    await expect(syncQuestion).toContainText('Codex has a question');
    await expect(syncQuestion).toContainText('Which option?');
    // The number keys pick an option when the focus is not in a text field.
    await syncQuestion.locator('.aya-gui-question-option').first().focus();
    await window.keyboard.press('1');
    await expect(syncQuestion.getByRole('button', { name: /A/ })).toHaveAttribute('aria-pressed', 'true');
    await syncQuestion.getByRole('textbox', { name: 'Which option?' }).fill('with custom note');
    await syncQuestion.getByRole('button', { name: 'Send answer', exact: true }).click();
    await expect(syncQuestion).toHaveCount(0);
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(gui.locator('.aya-gui-messages')).toContainText('A — with custom note');

    await prompt.fill('async-question'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('Turn complete');
    const asyncQuestion = gui.locator('article.assistant .aya-gui-question-card').last();
    await expect(asyncQuestion).toContainText('Allow non-zero instruction distance?');
    const firstOpt = asyncQuestion.getByRole('button', { name: 'Readable C, allow non-zero distance', exact: true });
    const secondOpt = asyncQuestion.getByRole('button', { name: 'Keep distance 0', exact: true });
    await expect(firstOpt).toBeVisible();
    await expect(secondOpt).toBeVisible();
    await secondOpt.click();
    await expect(secondOpt).toHaveAttribute('aria-pressed', 'true');
    await asyncQuestion.getByRole('textbox', { name: 'Allow non-zero instruction distance?' }).fill('preserve assembly parity');
    await asyncQuestion.getByRole('button', { name: 'Send answer', exact: true }).click();
    await expect(asyncQuestion).toHaveAttribute('data-answered', 'true');
    await expect(asyncQuestion).toContainText('Your answer: Keep distance 0 — preserve assembly parity');
    await expect(gui.locator('.aya-gui-messages')).toContainText('Answered: Keep distance 0 — preserve assembly parity');
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');

    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const reloadedQuestion = gui.locator('article.assistant .aya-gui-question-card').last();
    await expect(reloadedQuestion).toHaveAttribute('data-answered', 'true');
    await expect(reloadedQuestion).toContainText('Your answer: Keep distance 0 — preserve assembly parity');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('the composer recalls sent prompts, stashes drafts and quotes an assistant reply', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-codex-gui.cjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    const gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });

    await prompt.fill('widgets'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('Turn complete');
    await prompt.fill('question'); await prompt.press('Enter');
    await gui.locator('.aya-gui-request').getByRole('button', { name: 'Send answer', exact: true }).waitFor({ state: 'attached' });
    await gui.locator('.aya-gui-question-option').first().click();
    await gui.getByRole('button', { name: 'Send answer', exact: true }).click();
    await expect(turnStatus).toHaveText('Turn complete');

    // ArrowUp in an empty composer walks back through what was sent.
    await prompt.focus();
    await prompt.press('ArrowUp');
    await expect(prompt).toHaveValue('question');
    await prompt.press('ArrowUp');
    await expect(prompt).toHaveValue('widgets');
    await prompt.press('ArrowDown');
    await expect(prompt).toHaveValue('question');
    await prompt.press('ArrowDown');
    await expect(prompt).toHaveValue('');

    // Typed text is not replaced by recall.
    await prompt.fill('half a thought');
    await prompt.press('ArrowUp');
    await expect(prompt).toHaveValue('half a thought');

    // Cmd+S stashes the draft; in an empty composer it brings it back.
    await prompt.press('Meta+s');
    await expect(prompt).toHaveValue('');
    await expect(gui.locator('.aya-gui-stash')).toHaveText('Stash 1');
    await prompt.press('Meta+s');
    await expect(prompt).toHaveValue('half a thought');
    await expect(gui.locator('.aya-gui-stash')).toHaveCount(0);
    await prompt.fill('');

    // A very large paste becomes a text-file attachment instead of filling the composer.
    await prompt.evaluate(el => {
      const data = new DataTransfer(); data.setData('text/plain', 'line of pasted text\n'.repeat(3000));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(gui.locator('.aya-gui-attachments')).toContainText('pasted-text-');
    await expect(gui.locator('.aya-gui-attachments')).toContainText('3001 lines');
    await expect(prompt).toHaveValue('');
    await gui.getByRole('button', { name: /^Remove pasted-text-/ }).click();
    await expect(gui.locator('.aya-gui-attachments')).toHaveCount(0);
    await prompt.fill('a small paste stays text');
    await prompt.evaluate(el => {
      const data = new DataTransfer(); data.setData('text/plain', ' and short');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(gui.locator('.aya-gui-attachments')).toHaveCount(0);
    await prompt.fill('');

    // Cmd+F finds text in the conversation, steps through the matches and highlights them.
    await fireShortcut(app, 'find-in-pane');
    const find = gui.getByRole('searchbox', { name: 'Find in conversation' });
    await expect(find).toBeFocused();
    await find.fill('e');
    const results = gui.getByRole('status', { name: 'Find results' });
    await expect(results).toHaveText(/^1 of \d+$/);
    const total = Number(((await results.textContent()) ?? '').split(' of ')[1]);
    expect(total).toBeGreaterThanOrEqual(2);
    await find.press('Enter');
    await expect(results).toHaveText(`2 of ${total}`);
    await find.press('Shift+Enter');
    await expect(results).toHaveText(`1 of ${total}`);
    expect(await window.evaluate(() => CSS.highlights.get('aya-find-current')?.size ?? 0)).toBe(1);
    await find.fill('zzz-no-such-text');
    await expect(results).toHaveText('No results');
    await find.press('Escape');
    await expect(find).toHaveCount(0);
    await expect(prompt).toBeFocused();
    expect(await window.evaluate(() => CSS.highlights.size)).toBe(0);

    // The turn that just ended says how long it took.
    await expect(gui.locator('.aya-gui-turn-timer')).toHaveText(/^Worked for \d+s$/);

    // Selecting words of an assistant reply offers to quote them.
    const reply = gui.locator('article.assistant').first();
    await expect(reply).toBeVisible();
    const quoted = await reply.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node.querySelector('p') ?? node);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return selection.toString().trim();
    });
    await gui.locator('.aya-gui-messages').dispatchEvent('mouseup');
    await gui.getByRole('button', { name: 'Quote in composer', exact: true }).click();
    expect((await prompt.inputValue()).startsWith('> ')).toBe(true);
    expect(await prompt.inputValue()).toContain(quoted.split('\n')[0]);
    await expect(gui.getByRole('button', { name: 'Quote in composer', exact: true })).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('plan mode proposes a plan card that can be carried out', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-codex-gui.cjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    const gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const turnStatus = gui.getByRole('status', { name: 'Turn status' });
    const toggle = gui.getByRole('button', { name: /^Plan/ });

    await prompt.fill('/plan'); await prompt.press('Enter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await prompt.fill('add a LICENSE file'); await prompt.press('Enter');
    const card = gui.getByRole('article', { name: 'Proposed plan' });
    await expect(card).toContainText('Read the code');
    await expect(card).toContainText('Run the tests');
    await expect(turnStatus).toHaveText('Turn complete');
    await card.getByRole('button', { name: 'Implement this plan' }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(gui.locator('.aya-gui-messages')).toContainText('Implement the plan.');
    await expect(turnStatus).toHaveText('Turn complete');
    await expect(card.getByRole('button', { name: 'Implement this plan' })).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('Add context puts another terminal\'s output into the draft', async () => {
  const seed = seedEnv({ rightTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'shell', name: 'Shell', icon: '$', color: '', command: '$SHELL' }, { id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-codex-gui.cjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    const gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await gui.getByRole('button', { name: '@ Context' }).click();
    const menu = gui.getByRole('menu', { name: 'Add context' });
    await expect(menu.getByRole('menuitem', { name: /^Output of shell/ }).first()).toBeVisible();
    await menu.getByRole('menuitem', { name: /^Output of shell/ }).first().click();
    await expect(menu).toHaveCount(0);
    await expect(prompt).toHaveValue(/^Output of the terminal "shell \d":\n```\n/);
    await expect(prompt).toBeFocused();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('an async question preserves the draft and remains editable until its answer is delivered', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('async-question'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    const card = gui.locator('article.assistant .aya-gui-question-card').last();
    const answer = card.getByRole('textbox', { name: 'Allow non-zero instruction distance?' });
    await answer.fill('Reject this answer');
    await prompt.fill('Draft to keep');
    await card.getByRole('button', { name: 'Send answer' }).click();
    await expect(gui.getByRole('alert')).toContainText('The answer could not be sent');
    await expect(card).toHaveAttribute('data-answered', 'false');
    await expect(answer).toHaveValue('Reject this answer');
    await expect(prompt).toHaveValue('Draft to keep');

    await prompt.fill('wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('working');
    await prompt.fill('widgets'); await prompt.press('Enter');
    await prompt.fill('Draft to keep');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByText('Queue paused')).toBeVisible();
    await answer.fill('Keep distance 0');
    await card.getByRole('button', { name: 'Send answer' }).click();
    await expect(card).toContainText('Queued');
    await expect(card).toHaveAttribute('data-answered', 'false');
    await expect(prompt).toHaveValue('Draft to keep');
    await expect(gui.getByRole('textbox', { name: 'Queued message 2' })).toHaveValue('Keep distance 0');
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    await page.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(card).toContainText('Queued');
    await expect(prompt).toHaveValue('Draft to keep');
    await gui.getByRole('button', { name: 'Remove queued message 2' }).click();
    await expect(answer).toHaveValue('Keep distance 0');
    await card.getByRole('button', { name: 'Send answer' }).click();
    await gui.getByRole('button', { name: 'Resume queue' }).click();
    await expect(card).toHaveAttribute('data-answered', 'true');
    await expect(card).toContainText('Your answer: Keep distance 0');
    await expect(prompt).toHaveValue('Draft to keep');

    await prompt.fill('async-question-wait'); await prompt.press('Enter');
    const activeCard = gui.locator('article.assistant .aya-gui-question-card').last();
    await activeCard.getByRole('button', { name: 'First', exact: true }).click();
    await prompt.fill('Another draft to keep');
    await activeCard.getByRole('button', { name: 'Send answer' }).click();
    await expect(gui.getByRole('alert')).toContainText('Steering was rejected');
    await expect(activeCard).toHaveAttribute('data-answered', 'false');
    await expect(prompt).toHaveValue('Another draft to keep');
    await activeCard.getByRole('button', { name: 'Send answer' }).click();
    await expect(activeCard).toHaveAttribute('data-answered', 'true');
    await expect(gui.getByRole('alert')).toHaveCount(0);
    await expect(prompt).toHaveValue('Another draft to keep');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('dropping files into a conversation gives a visible alternative', async () => {
  const seed = seedCodexGui();
  const file = join(seed.projectDir, 'example.txt'); writeFileSync(file, 'example');
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const box = await gui.getByRole('textbox', { name: 'Message Codex' }).boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    const x = box!.x + 30, y = box!.y + 20;
    try {
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    } finally { await cdp.detach(); }
    await expect(gui.getByRole('alert')).toContainText('Use + to attach files');
    await expect(gui.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('an asynchronous secret question does not ask for a value in saved chat', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('async-secret-question'); await prompt.press('Enter');
    const card = gui.locator('article.assistant .aya-gui-question-card').last();
    await expect(card).toContainText('Ask the agent for a secure way');
    await expect(card.getByRole('textbox')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Send answer' })).toHaveCount(0);

    await prompt.fill('question-secret'); await prompt.press('Enter');
    const request = gui.locator('.aya-gui-request.aya-gui-question-card');
    const secret = request.getByLabel('Enter secret');
    await expect(secret).toHaveAttribute('type', 'password');
    await secret.fill('SECRET_MARKER_FOR_TEST');
    await request.getByRole('button', { name: 'Send answer' }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    await expect(gui.locator('.aya-gui-messages')).not.toContainText('SECRET_MARKER_FOR_TEST');
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    const persisted = readdirSync(join(seed.ayaHome, 'conversations')).filter(name => name.endsWith('.json')).map(name => readFileSync(join(seed.ayaHome, 'conversations', name), 'utf8')).join('\n');
    expect(persisted).not.toContain('SECRET_MARKER_FOR_TEST');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('artifact tables explain when there are no rows or no matching rows', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('widgets'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    await gui.getByRole('button', { name: /^Artifacts/ }).click();
    const filter = gui.getByRole('textbox', { name: 'Filter rows' });
    await filter.fill('nothing matches');
    await expect(gui.getByText('No matching rows', { exact: true })).toBeVisible();
    await filter.fill('');
    await expect(gui.getByRole('complementary', { name: 'Artifacts' }).getByRole('cell', { name: 'Aya' })).toBeVisible();
    await prompt.fill('empty-table'); await prompt.press('Enter');
    await expect(gui.getByText('No rows to display', { exact: true })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('artifacts do not squeeze a narrow conversation in a desktop split', async () => {
  const seed = seedEnv({ rightTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [
    { id: 'shell', name: 'Shell', icon: '$', color: '', command: 'cat' },
    { id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' },
  ] });
  installFakeCodexGui(seed);
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const pane = await gui.boundingBox();
    expect(pane!.width).toBeLessThan(850);
    await gui.getByRole('button', { name: 'Artifacts', exact: true }).click();
    const main = await gui.locator('.aya-gui-body > main').boundingBox();
    const artifacts = gui.getByRole('complementary', { name: 'Artifacts' });
    await expect(artifacts).toHaveCSS('position', 'absolute');
    expect(main!.width).toBeGreaterThan(pane!.width - 10);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('artifact save errors stay visible until the user retries', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const file = join(seed.root, 'widget.html');
    await app.evaluate(({ dialog }, output) => {
      let calls = 0;
      dialog.showSaveDialog = (async () => {
        if (calls++ === 0) throw Error('Temporary save error');
        return { canceled: false, filePath: output };
      }) as typeof dialog.showSaveDialog;
    }, file);
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('html-widget'); await prompt.press('Enter');
    await expect(gui.frameLocator('iframe[title="Capacity planner"]').getByRole('heading', { name: 'Team capacity' })).toBeVisible();
    await gui.getByRole('button', { name: 'Save ↓' }).click();
    const feedback = gui.locator('.aya-artifact-feedback');
    await expect(feedback).toHaveText('Could not save. Try again.');
    await page.waitForTimeout(3000);
    await expect(feedback).toHaveText('Could not save. Try again.');
    await gui.getByRole('button', { name: 'Save ↓' }).click();
    await expect(feedback).toHaveText('Saved');
    expect(existsSync(file)).toBe(true);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

for (const unsafeMode of [false, true]) {
  test(`conversation shows its unsafe approval mode: ${unsafeMode}`, async () => {
    const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui', unsafeMode }] });
    installFakeCodexGui(seed);
    const app = await launchApp(seed);
    try {
      const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
      await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
      await expect(gui.locator('header').getByText('Unsafe approvals', { exact: true })).toHaveCount(unsafeMode ? 1 : 0);
      if (unsafeMode) await expect(gui.locator('.aya-gui-unsafe-badge')).toHaveAttribute('title', /without the workspace sandbox/);
    } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
  });
}

test('GUI attachments route to Codex and retain the draft if they must be reattached', async () => {
  const seed = seedCodexGui();
  const textFile = join(seed.projectDir, 'notes.txt'), imageFile = join(seed.projectDir, 'image.png');
  writeFileSync(textFile, 'Notes for the test');
  writeFileSync(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRc8AAAAASUVORK5CYII=', 'base64'));
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as typeof dialog.showOpenDialog;
    }, [textFile, imageFile]);
    await page.evaluate(() => {
      const state = window as unknown as { capturedTurns: unknown[]; ayaGui: { onEvent: (id: string, fn: (event: { method: string; params: unknown }) => void) => void } };
      state.capturedTurns = [];
      state.ayaGui.onEvent('tab-left', event => { if (event.method === 'fixture/turn') state.capturedTurns.push(event.params); });
    });
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await gui.getByRole('button', { name: 'Attach files' }).click();
    await expect(gui.locator('.aya-gui-attachments')).toContainText('notes.txt');
    await expect(gui.locator('.aya-gui-attachments')).toContainText('image.png');
    await prompt.fill('Inspect these files'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    const input = await page.evaluate(() => (window as unknown as { capturedTurns: { input: { type: string; text?: string; path?: string }[] }[] }).capturedTurns.at(-1)?.input);
    expect(input?.find(part => part.type === 'text')?.text).toContain(textFile);
    expect(input?.find(part => part.type === 'localImage')?.path).toBe(imageFile);

    await gui.getByRole('button', { name: 'Attach files' }).click();
    await prompt.fill('Draft with attachments');
    await expect.poll(() => {
      try { return readdirSync(join(seed.ayaHome, 'conversations')).filter(name => name.endsWith('.json')).some(name => readFileSync(join(seed.ayaHome, 'conversations', name), 'utf8').includes('Draft with attachments')); } catch { return false; }
    }).toBe(true);
    await page.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(prompt).toHaveValue('Draft with attachments');
    await expect(gui.locator('.aya-gui-attachments')).toContainText('notes.txt');
    await expect(gui.locator('.aya-gui-attachments')).toContainText('Reattach');
    await prompt.press('Enter');
    await expect(gui.getByRole('alert')).toContainText('Please reattach this file');
    await expect(prompt).toHaveValue('Draft with attachments');
    await expect(gui.locator('.aya-gui-attachments')).toContainText('image.png');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('restored queued attachments are marked for reattachment before resuming', async () => {
  const seed = seedCodexGui();
  const file = join(seed.projectDir, 'notes.txt'); writeFileSync(file, 'Notes for the test');
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog;
    }, file);
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('working');
    await gui.getByRole('button', { name: 'Attach files' }).click();
    await prompt.fill('Queued with a file'); await prompt.press('Enter');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('Queued with a file');
    await expect(gui.locator('.aya-gui-queued')).not.toContainText('(reattach)');
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByText('Queue paused')).toBeVisible();
    await expect.poll(() => {
      try { return readdirSync(join(seed.ayaHome, 'conversations')).filter(name => name.endsWith('.json')).some(name => readFileSync(join(seed.ayaHome, 'conversations', name), 'utf8').includes('Queued with a file')); } catch { return false; }
    }).toBe(true);
    await page.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('Queued with a file');
    await expect(gui.locator('.aya-gui-queued')).toContainText('notes.txt (reattach)');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('attachment limits explain rejected and partially added selections', async () => {
  const seed = seedCodexGui();
  const files = Array.from({ length: 21 }, (_, index) => join(seed.projectDir, `file-${index}.txt`));
  for (const file of files) writeFileSync(file, 'test');
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await app.evaluate(({ dialog }, paths) => {
      let calls = 0;
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths, paths.slice(0, 19), paths.slice(19)][calls++] })) as typeof dialog.showOpenDialog;
    }, files);
    const attach = gui.getByRole('button', { name: 'Attach files' });
    await attach.click();
    await expect(gui.getByRole('alert')).toContainText('Select at most 20 files');
    await expect(gui.locator('.aya-gui-attachments')).toHaveCount(0);
    await attach.click();
    await expect(gui.locator('.aya-gui-attachments > span')).toHaveCount(19);
    await attach.click();
    await expect(gui.locator('.aya-gui-attachments > span')).toHaveCount(20);
    await expect(gui.getByRole('alert')).toContainText('Added 1 of 2 files');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('pasted images become attachments without replacing the message draft', async () => {
  const seed = seedCodexGui();
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const sampleImage = (await page.screenshot()).toString('base64');
    await app.evaluate(({ clipboard, nativeImage }, sample) => {
      const image = nativeImage.createFromBuffer(Buffer.from(sample, 'base64'));
      if (image.isEmpty()) throw Error('Test image did not decode');
      clipboard.readImage = () => image;
    }, sampleImage);
    await page.evaluate(() => {
      const state = window as unknown as { capturedTurns: unknown[]; ayaGui: { onEvent: (id: string, fn: (event: { method: string; params: unknown }) => void) => void } };
      state.capturedTurns = [];
      state.ayaGui.onEvent('tab-left', event => { if (event.method === 'fixture/turn') state.capturedTurns.push(event.params); });
    });
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('Explain this image');
    await prompt.evaluate(node => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([1])], 'clipboard.png', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(gui.locator('.aya-gui-attachments')).toContainText('clipboard-');
    await expect(prompt).toHaveValue('Explain this image');
    await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    const input = await page.evaluate(() => (window as unknown as { capturedTurns: { input: { type: string; path?: string }[] }[] }).capturedTurns.at(-1)?.input);
    const pasted = input?.find(part => part.type === 'localImage')?.path;
    expect(pasted).toBeTruthy();
    expect(pasted!.startsWith(join(seed.ayaHome, 'gui-attachments') + '/')).toBe(true);
    expect(existsSync(pasted!)).toBe(true);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
