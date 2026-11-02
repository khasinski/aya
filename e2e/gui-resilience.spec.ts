import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function guiSeed() {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  const bin = join(seed.root, 'bin'); mkdirSync(bin);
  const starts = join(seed.root, 'agent-starts.log');
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(starts)},process.pid+'\\n');require(${JSON.stringify(resolve('tests/helpers/fake-codex-gui.cjs'))});\n`, { mode: 0o755 });
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  return { seed, starts };
}

test('a new GUI goal is active after completing its predecessor', async () => {
  const { seed } = guiSeed(), app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('/goal First objective'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Active');
    await prompt.fill('complete-goal'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Complete');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
    await prompt.fill('/goal Second objective'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Goal status' })).toHaveText('Active');
    await expect(gui.locator('.aya-gui-goal-objective')).toHaveText('Second objective');
    await expect(gui.getByRole('article', { name: 'Goal set', exact: true })).toHaveCount(2);
    await expect(gui.getByRole('article', { name: 'Goal completed' })).toContainText('First objective');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('renderer crashes preserve the running GUI process, streamed answer and pending approval', async () => {
  const { seed, starts } = guiSeed(), app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { message: string; buttons: string[] };
        if (!options.buttons.includes('Reload window')) throw Error('Unexpected recovery dialog');
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('long-stream'); await prompt.press('Enter');
    await expect(gui.locator('article.assistant')).toContainText('Paragraph 10:');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    // Playwright marks its original Page as permanently crashed. Inspect the
    // replacement renderer through the surviving WebContents instead.
    const live = async <T,>(expression: string): Promise<T> => {
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Runtime.runIfWaitingForDebugger');
        const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        return result.result.value as T;
      } finally { await cdp.detach().catch(() => {}); }
    };
    await expect.poll(() => live<string>(`document.querySelector('.aya-gui-header [role="status"]')?.textContent`).catch(() => 'recovering'), { timeout: 15000 }).toBe('Ready');
    await expect.poll(() => live<string>(`document.querySelector('[aria-label="Turn status"]')?.textContent`)).toContain('Turn complete');
    const text = await live<string>(`document.querySelector('article.assistant').innerText`);
    expect(text).toContain('Paragraph 80:'); expect(text.match(/Paragraph 10:/g)).toHaveLength(1);
    expect(readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(1);
    await live(`window.ayaGui.invoke('tab-left', 'send', { text: 'approval' })`);
    await expect.poll(() => live<boolean>(`[...document.querySelectorAll('button')].some(button => button.textContent === 'Allow once')`)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await expect.poll(() => live<number>(`[...document.querySelectorAll('button')].filter(button => button.textContent === 'Allow once').length`).catch(() => 0), { timeout: 15000 }).toBe(1);
    await live(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Allow once').click()`);
    await expect.poll(() => live<string>(`document.querySelector('[aria-label="Turn status"]')?.textContent`)).toContain('Turn complete');
    expect(readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(1);
    // A dead backend must stay disconnected after recovery instead of falsely
    // reporting Ready or automatically launching another agent.
    await live(`window.ayaGui.invoke('tab-left', 'send', { text: 'disconnect-approval' })`);
    await expect.poll(() => live<string>(`document.querySelector('.aya-gui-header [role="status"]')?.textContent`)).toBe('Disconnected');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await expect.poll(() => live<boolean>(`[...document.querySelectorAll('button')].some(button => button.textContent === 'Reconnect')`).catch(() => false), { timeout: 15000 }).toBe(true);
    expect(readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(1);
    await live(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Reconnect').click()`);
    await expect.poll(() => live<string>(`document.querySelector('.aya-gui-header [role="status"]')?.textContent`)).toBe('Ready');
    expect(readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('a React render failure retains the GUI process and unsaved draft before error-screen reload', async () => {
  const { seed, starts } = guiSeed(), app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('wait'); await prompt.press('Enter');
    await expect(gui.getByRole('status', { name: 'Turn status' })).toContainText('is working');
    await prompt.fill('Draft retained through a render failure');
    // Fault injection bypasses the valid artifact tool so React really throws;
    // main's persisted artifact library remains valid for recovery.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('codex-gui:event', 'tab-left', { method: 'aya/artifact', params: { open: true, artifact: { id: 'render-fault', title: 'Render fault', kind: 'table', columns: null, rows: null } } }));
    await expect(page.getByText('This window hit an error')).toBeVisible();
    await page.getByRole('button', { name: 'Reload window', exact: true }).click();
    await expect(gui.locator('header').getByRole('status')).toContainText('is working');
    await expect(prompt).toHaveValue('Draft retained through a render failure');
    expect(readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(1);
    await gui.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Interrupted');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
