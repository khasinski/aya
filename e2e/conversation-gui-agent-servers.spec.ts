import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedCodexGui } from './helpers/codex-gui';
import { seedEnv } from './helpers/seed';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const openedUrls = (root: string) => { try { return readFileSync(join(root, 'e2e-open-external.log'), 'utf8'); } catch { return ''; } };

/** Open the badge's list, open the server through Aya, stop it; the badge goes away and the process is gone. */
async function openAndStop(window: Page, root: string, port: number, pid: number) {
  const badge = window.getByRole('button', { name: '1 server', exact: true });
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await badge.click();
  const list = window.getByRole('dialog', { name: 'Local servers' });
  const row = list.locator(`[data-pid="${pid}"]`);
  await expect(row).toContainText(`pid ${pid}`);
  await expect(row.locator('code')).toContainText('createServer');
  await row.getByRole('button', { name: `Open :${port}` }).click();
  // Never a real browser: in e2e main's externalShell records the URL instead.
  await expect.poll(() => openedUrls(root)).toContain(`http://localhost:${port}/\n`);
  await row.getByRole('button', { name: /^Stop / }).click();
  await expect(badge).toHaveCount(0, { timeout: 20_000 });
  await expect(list).toHaveCount(0);
  await expect.poll(() => alive(pid)).toBe(false);
}

test('a conversation agent\'s local server is listed with its port, opens through Aya and stops', async () => {
  const seed = seedCodexGui();
  // The extensionless fake agent must load as CommonJS even under a stray type:module package.json above /tmp.
  writeFileSync(join(seed.root, 'package.json'), '{"type":"commonjs"}');
  const app = await launchApp(seed);
  let pid = 0;
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await expect(window.getByRole('button', { name: /^\d+ servers?$/ })).toHaveCount(0);
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('start-server'); await prompt.press('Enter');
    const reply = gui.getByText(/Dev server on port \d+ pid \d+/);
    await expect(reply).toBeVisible();
    const [, port, server] = (await reply.textContent())!.match(/port (\d+) pid (\d+)/)!;
    pid = Number(server);
    await openAndStop(window, seed.root, Number(port), pid);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true });
  }
});

test('a terminal pane lists the server its process started and stops it', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'srv', name: 'Server pane' }, presetList: [{ id: 'srv', name: 'Server pane', icon: '◆', color: '', command: 'node server-parent.cjs' }] });
  const { projectDir } = seed;
  const info = join(seed.root, 'server.json');
  // The pane's process starts the server as its child, as an agent's tool call would.
  writeFileSync(join(projectDir, 'server-parent.cjs'), `const child = require('node:child_process').spawn(process.execPath, ['-e', "require('http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',function(){process.stdout.write(this.address().port+String.fromCharCode(10))})"], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', d => { require('node:fs').writeFileSync(${JSON.stringify(info)}, JSON.stringify({ port: Number(String(d).trim()), pid: child.pid })); console.log('server ready'); });
setInterval(() => {}, 1000);
`);
  const app = await launchApp(seed);
  let pid = 0;
  try {
    const window = await app.firstWindow();
    await expect.poll(() => { try { return JSON.parse(readFileSync(info, 'utf8')).pid; } catch { return 0; } }, { timeout: 20_000 }).toBeGreaterThan(0);
    const started = JSON.parse(readFileSync(info, 'utf8')) as { port: number; pid: number };
    pid = started.pid;
    await openAndStop(window, seed.root, started.port, pid);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true });
  }
});
