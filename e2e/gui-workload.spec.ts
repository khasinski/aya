import { test, expect, launchApp, closeAndWait } from './fixtures';
import { GUI_WORKLOAD, seedGuiWorkload } from './helpers/gui-workload';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

test('large GUI workload records opening, input-to-frame latency and memory while keeping history usable', async () => {
  test.setTimeout(60000);
  const seed = seedGuiWorkload(), start = performance.now(), app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready', { timeout: 30000 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const openingMs = performance.now() - start;
    await expect(gui.locator('article.assistant')).toHaveCount(GUI_WORKLOAD.messages);
    const skipped = await gui.locator('article.assistant').evaluateAll(nodes => nodes.filter(node => node.firstElementChild && !node.firstElementChild.checkVisibility({ contentVisibilityAuto: true })).length);
    expect(skipped).toBeGreaterThan(0);
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(join(seed.ayaHome, 'pty-owner', 'record.json'), 'utf8')).panes.length; } catch { return 0; }
    }).toBeGreaterThanOrEqual(GUI_WORKLOAD.terminals);
    const session = await page.context().newCDPSession(page);
    const heap = await session.send('Runtime.getHeapUsage');
    await session.detach();
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ type: metric.type, memoryKiB: metric.memory, cpu: metric.cpu })));
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    const samples: number[] = [];
    for (const key of 'inputlatencybenchmark') {
      const inputStart = performance.now(); await prompt.press(key);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      samples.push(performance.now() - inputStart);
    }
    await expect(prompt).toHaveValue('inputlatencybenchmark');
    expect(samples.length).toBeGreaterThanOrEqual(20);
    const previewStart = performance.now();
    await gui.getByRole('button', { name: 'Artifacts', exact: true }).click();
    // Cold CI workers render 2,500 messages while preparing the first preview.
    // Measure that latency below without imposing the normal small-view timeout.
    // Polled every frame: toBeVisible retries at growing intervals (up to 1 s), which is too coarse to time against.
    const widgetHeading = gui.frameLocator('iframe').getByRole('heading', { name: 'Benchmark widget 0' });
    await expect.poll(() => widgetHeading.isVisible(), { intervals: [16], timeout: 30000 }).toBe(true);
    const artifactOpenMs = performance.now() - previewStart;
    // The whole text remains in the DOM, selectable and reachable by Chromium find.
    const matches = await app.evaluate(({ BrowserWindow }) => new Promise<number>(resolve => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const listener = (_event: Electron.Event, result: Electron.Result) => { if (result.finalUpdate) { contents.removeListener('found-in-page', listener); resolve(result.matches); } };
      contents.on('found-in-page', listener); contents.findInPage('History needle 17:');
    }));
    expect(matches).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.stopFindInPage('clearSelection'));
    const selection = await gui.locator('article.assistant').nth(17).evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); const text = selection.toString(); selection.removeAllRanges(); return text;
    });
    expect(selection).toContain('History needle 17:');
    const sorted = [...samples].sort((a, b) => a - b);
    // Budgets, not only a record. Typing must stay well under what a person notices (measured 16 ms median, 18 ms p95
    // on an M-series Mac, 2026-11); a command's result must come within the Doherty threshold of 400 ms. CI workers are
    // several times slower and render the 2,500 messages cold, so there the numbers are recorded and not judged.
    if (!process.env.CI) {
      expect(sorted[Math.floor(sorted.length * 0.95)], `input-to-frame p95 of ${sorted.map((ms) => Math.round(ms)).join(", ")} ms`).toBeLessThan(100);
      expect(artifactOpenMs, 'opening the artifact preview').toBeLessThan(400);
    }
    const output = resolve(process.env.AYA_GUI_BENCHMARK_OUTPUT || '.gui-verification/gui-workload.json.log'); mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ workload: GUI_WORKLOAD, platform: process.platform, arch: process.arch, openingMs, artifactOpenMs, inputToFrameMs: { samples, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] }, rendererHeapBytes: heap, electronProcesses: processes, skippedOffscreenMessages: skipped, notes: ['Includes Electron startup and four shell terminals.', 'Input timing is a Playwright key command to the next frame, including automation transport overhead.', 'Process memory is reported by Electron in KiB; shared pages can overlap, external PTY owner memory is not included.', 'Hardware-dependent measurements; correctness checks are enforced, no machine-specific speed threshold.'] }, null, 2));
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
