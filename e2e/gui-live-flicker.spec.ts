// Opt-in: exercises the real installed Codex and account in a disposable Aya
// workspace. Copy only its auth file; all test session data stays in the seed.
import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('real Codex streams a response without losing the conversation surface', async ({}, testInfo) => {
  test.skip(process.env.AYA_REAL_GUI_TEST !== '1', 'Uses a real Codex account and model call; opt in with AYA_REAL_GUI_TEST=1');
  test.setTimeout(150_000);
  const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  test.skip(!existsSync(auth), 'Codex auth.json is required for the isolated test account');
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }], snippetList: [{ id: 'hold', name: 'Insert sample', text: 'GUI_SNIPPET', autoRun: false }, { id: 'run', name: 'Send queued sample', text: 'Reply exactly QUEUED_OK, with no tools.', autoRun: true }] });
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    const codexHome = join(seed.root, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    copyFileSync(auth, join(codexHome, 'auth.json'));
    const historyCount = Number(process.env.AYA_GUI_HISTORY_COUNT || 0);
    const useTools = process.env.AYA_GUI_USE_TOOLS === '1';
    const steerAndQueue = process.env.AYA_GUI_STEER === '1';
    if (historyCount > 0) {
      const directory = join(seed.ayaHome, 'conversations');
      mkdirSync(directory, { recursive: true });
      const messages = Array.from({ length: historyCount }, (_, i) => ({ id: `history-${i}`, type: 'assistant', text: `Earlier response ${i}: ` + 'A previous answer in this long conversation. '.repeat(16) }));
      const filename = createHash('sha256').update(seed.tabIds.left).digest('hex') + '.json';
      writeFileSync(join(directory, filename), JSON.stringify({ cwd: seed.projectDir, agent: 'codex', view: { messages, turnOutcome: 'complete' } }));
    }
    seed.launchEnv = { AYA_E2E_CODEX_BIN: process.env.AYA_REAL_CODEX_BIN || 'codex' };
    app = await launchApp(seed);
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready', { timeout: 45_000 });
    await expect(gui.locator('article.assistant')).toHaveCount(historyCount);
    await page.evaluate(() => {
      const samples: { at: number; visible: boolean; count: number; length: number; top: number; height: number; scrollHeight: number; anchorTop: number | null }[] = [];
      const root = document.querySelector<HTMLElement>('.aya-conversation')!;
      const viewport = root.querySelector<HTMLElement>('.aya-gui-messages')!;
      const tick = () => {
        const rect = root.getBoundingClientRect(), style = getComputedStyle(root);
        const anchor = (window as unknown as { flickerAnchor?: HTMLElement }).flickerAnchor;
        samples.push({ at: performance.now(), visible: root.isConnected && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0, count: root.querySelectorAll('article').length, length: root.querySelector('.aya-gui-message-content')?.textContent?.length || 0, top: viewport.scrollTop, height: viewport.clientHeight, scrollHeight: viewport.scrollHeight, anchorTop: anchor ? anchor.getBoundingClientRect().top : null });
        if ((window as unknown as { flickerRecording: boolean }).flickerRecording) requestAnimationFrame(tick);
      };
      Object.assign(window, { flickerSamples: samples, flickerRecording: true });
      requestAnimationFrame(tick);
    });
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    if (process.env.AYA_GUI_SNIPPET === '1') {
      await page.getByTestId('snippet-toggle').click();
      await gui.getByTestId('snippet-item').filter({ hasText: 'Insert sample' }).click();
      await expect(prompt).toHaveValue('GUI_SNIPPET');
    }
    await prompt.fill(useTools
      ? 'Use the shell tool to run exactly `pwd`, then write 18 numbered paragraphs of 35 to 45 words each explaining how to keep a chat interface stable while it streams. Do not read files, use the web, run other commands, or delegate.'
      : 'Write 18 numbered paragraphs of 35 to 45 words each explaining how to keep a long-running chat interface stable while it streams text. Use plain language. Do not use tools, read files, or delegate.');
    await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('working', { timeout: 30_000 });
    await expect(gui.locator('article.assistant')).toHaveCount(historyCount + 1, { timeout: 90_000 });
    if (useTools) await expect(gui.locator('.aya-gui-activity-list > details')).not.toHaveCount(0, { timeout: 30_000 });
    if (historyCount > 0 && process.env.AYA_GUI_SCROLL_HISTORY === '1') {
      const anchor = gui.locator('article.assistant').nth(Math.floor(historyCount / 2));
      await anchor.scrollIntoViewIfNeeded();
      await anchor.evaluate(node => { (window as unknown as { flickerAnchor: HTMLElement }).flickerAnchor = node as HTMLElement; });
      await expect(gui.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    }
    if (steerAndQueue) {
      await prompt.fill('Please keep the remaining paragraphs concise.');
      await gui.getByRole('button', { name: /Steer/ }).click();
      await expect(gui.locator('article.user').last()).toContainText('Please keep the remaining paragraphs concise.');
      if (process.env.AYA_GUI_SNIPPET === '1') {
        await page.getByTestId('snippet-toggle').click();
        await gui.getByTestId('snippet-item').filter({ hasText: 'Send queued sample' }).click();
      } else {
        await prompt.fill('Reply exactly QUEUED_OK, with no tools.');
        await prompt.press('Enter');
      }
      await expect(gui.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('Reply exactly QUEUED_OK, with no tools.');
    }
    for (let i = 0; i < 15; i++) {
      await page.screenshot({ path: testInfo.outputPath(`frame-${String(i).padStart(2, '0')}.png`) });
      await page.waitForTimeout(500);
    }
    if (steerAndQueue) await expect(gui.locator('article.assistant').last()).toContainText('QUEUED_OK', { timeout: 110_000 });
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete', { timeout: 90_000 });
    const samples = await page.evaluate(() => {
      const data = window as unknown as { flickerRecording: boolean; flickerSamples: { at: number; visible: boolean; count: number; length: number; top: number; height: number; scrollHeight: number; anchorTop: number | null }[] };
      data.flickerRecording = false;
      return data.flickerSamples;
    });
    writeFileSync(testInfo.outputPath('frame-metrics.json'), JSON.stringify(samples));
    await testInfo.attach('frame-metrics.json', { body: Buffer.from(JSON.stringify(samples)), contentType: 'application/json' });
    expect(samples.length).toBeGreaterThan(30);
    expect(samples.filter(sample => !sample.visible)).toHaveLength(0);
    const afterFirstAnswer = samples.findIndex(sample => sample.count >= historyCount + 2);
    expect(afterFirstAnswer).toBeGreaterThanOrEqual(0);
    expect(samples.slice(afterFirstAnswer).filter(sample => sample.count < historyCount + 2)).toHaveLength(0);
    if (historyCount > 0 && process.env.AYA_GUI_SCROLL_HISTORY === '1') {
      const anchored = samples.filter(sample => sample.anchorTop !== null);
      const positions = anchored.map(sample => sample.anchorTop as number);
      expect(positions.length).toBeGreaterThan(30);
      // A jump into a virtualized history can have one small initial layout
      // correction. Once settled, streaming and queue dispatch must keep the
      // same text in place rather than pulling the reader to the bottom.
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(32);
      const settled = anchored.filter(sample => sample.at >= anchored[0].at + 250).map(sample => sample.anchorTop as number);
      expect(Math.max(...settled) - Math.min(...settled)).toBeLessThan(8);
    }
    await expect(gui.locator('article.assistant').last()).not.toBeEmpty();
  } finally { try { if (app) await closeAndWait(app); } finally { rmSync(seed.root, { recursive: true, force: true }); } }
});
