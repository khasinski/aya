import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { mkdirSync, copyFileSync, chmodSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
test('experimental GUI lives inside Aya with closed artifacts, approvals and explicit commands', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-codex-gui.cjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
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
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' })).toHaveValue(await gui.getByRole('combobox').locator('option').filter({ hasText: 'Opened by Codex' }).getAttribute('value') as string);
    await gui.locator('header').getByRole('button', { name: /Artifacts/ }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await prompt.fill('reopen'); await prompt.press('Enter');
    await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toContainText('Opened by Codex');
    await expect(gui.getByRole('button', { name: 'Artifacts 2' })).toBeVisible();
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
    await prompt.fill('approval'); await prompt.press('Enter');
    await expect(gui.getByText('Approval required')).toBeVisible();
    await expect(turnStatus).toHaveText('Waiting for your response');
    await expect(turnStatus).toHaveAttribute('data-working', 'false');
    await gui.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
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
      try { return readdirSync(join(seed.ayaHome, 'conversations')).some(file => readFileSync(join(seed.ayaHome, 'conversations', file), 'utf8').includes('Aya mark')); } catch { return false; }
    }).toBe(true);
    await window.reload();
    await expect(window.locator('.aya-conversation header').getByRole('status')).toHaveText('Ready');
    await expect(window.locator('.aya-conversation').getByRole('alert')).toHaveCount(0);
    await expect(gui.getByRole('img', { name: 'Aya mark' })).toBeVisible();
    await gui.getByRole('button', { name: 'Previous artifact' }).click();
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' })).toContainText('Capacity planner');
    await expect(gui.frameLocator('iframe[title="Capacity planner"]').getByRole('heading', { name: 'Updated capacity' })).toBeVisible();
    await gui.getByRole('button', { name: 'Next artifact' }).click();
    await expect(gui.getByRole('img', { name: 'Aya mark' })).toBeVisible();
    const search = gui.getByRole('searchbox', { name: 'Search artifacts' });
    await search.fill('four-person');
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' }).locator('option')).toHaveCount(1);
    await expect(gui.getByRole('combobox', { name: 'Selected artifact' })).toContainText('Capacity planner');
    await search.fill('nothing-matches-this');
    await expect(gui.getByText('No matching artifacts')).toBeVisible();
    await gui.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(search).toHaveValue('');
    await gui.getByRole('combobox', { name: 'Model for next turn' }).selectOption('fake-pro');
    await gui.getByRole('combobox', { name: 'Reasoning effort' }).selectOption('high');
    await prompt.fill('wait'); await prompt.press('Enter');
    await expect(turnStatus).toHaveText('Codex is working…');
    await prompt.fill('Focus on the interaction details');
    await gui.getByRole('button', { name: 'Steer ↗', exact: true }).click();
    await expect(prompt).toHaveValue('');
    await expect(gui.locator('.aya-gui-messages')).toContainText('↳ Focus on the interaction details');
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
    await expect.poll(() => { try { return readdirSync(join(seed.ayaHome, 'conversations')).some(file => readFileSync(join(seed.ayaHome, 'conversations', file), 'utf8').includes('Decompiled four functions')); } catch { return false; } }).toBe(true);
    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const resumedProgress = gui.locator('.aya-gui-messages').getByRole('progressbar', { name: 'Decompiling functions' }).last();
    await expect(resumedProgress).toHaveAttribute('aria-valuenow', '4');
    await expect(resumedProgress).toHaveAttribute('aria-valuetext', '4 of 10 · Paused');
    await expect(gui.locator('.aya-task-progress--compact')).toHaveCount(0);

    await window.screenshot({ path: 'test-results/conversation-gui.png' });
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
      await expect(gui.getByText('Approval required')).toBeVisible();
      await gui.getByRole('button', { name: 'Decline', exact: true }).click();
      await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');

      await prompt.fill('/goal Deliver multi-agent GUI');
      await prompt.press('Enter');
      await expect(gui.locator('.aya-gui-goal')).toContainText('Deliver multi-agent GUI');
      await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Active');

      await prompt.fill('/btw Quick check');
      await prompt.press('Enter');
      await expect(gui.locator('.aya-gui-side')).toContainText(agentSpec.sideAnswer);
    } finally {
      await closeAndWait(app);
      rmSync(seed.root, { recursive: true, force: true });
    }
  });
}


test('resume picker preserves drafts and artifacts, imports native history and survives delayed send acknowledgement', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-codex-gui.cjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
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
