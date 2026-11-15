import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedCodexGui } from './helpers/codex-gui';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import type { Locator } from '@playwright/test';

const run = promisify(execFile);
const html = `<style>video{width:240px;display:block;margin:8px 0}</style><h2>Video demo</h2>
<video id="mp4" controls preload="auto" src="../clip.mp4"><track kind="captions" src="./captions.vtt" srclang="en" default></video><button onclick="document.querySelector('#mp4').play()">Play MP4</button>
<video id="webm" controls preload="auto"><source src="../clip.webm" type="video/webm"></video><button onclick="document.querySelector('#webm').play()">Play WebM</button>
<video id="dynamic" controls preload="auto"></video><script>document.querySelector('#dynamic').src=window.ayaWidget.asset('../clip.webm');</script>`;
function prepare(project: string) {
  mkdirSync(join(project, 'reports'));
  for (const format of ['mp4', 'webm']) copyFileSync(resolve('tests/fixtures/artifact-video.' + format), join(project, 'clip.' + format));
  writeFileSync(join(project, 'reports/video.html'), html);
  writeFileSync(join(project, 'reports/captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:03.000\nSynthetic video caption\n');
}
async function ready(video: Locator) {
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => ({ ready: node.readyState >= 2, error: node.error?.message || null })), { timeout: 10000 }).toEqual({ ready: true, error: null });
  await expect(video).toHaveAttribute('controls', '');
}

test('GUI video plays MP4/WebM, seeks, exports and survives reload without its original files', async () => {
  const seed = seedCodexGui(); prepare(seed.projectDir);
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('video-artifact'); await prompt.press('Enter');
    const frame = gui.frameLocator('iframe[title="Local video"]');
    await expect(frame.getByRole('heading', { name: 'Video demo' })).toBeVisible();
    for (const id of ['mp4', 'webm', 'dynamic']) await ready(frame.locator('#' + id));
    await frame.getByRole('button', { name: 'Play MP4', exact: true }).click();
    await expect.poll(() => frame.locator('#mp4').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.1);
    await expect.poll(() => frame.locator('track').evaluate((track: HTMLTrackElement) => track.readyState)).toBe(2);
    expect(await frame.locator('#mp4').evaluate((v: HTMLVideoElement) => {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext('2d')!; context.drawImage(v, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data.length;
    })).toBe(4);
    await frame.locator('#mp4').evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 1.5; });
    await expect.poll(() => frame.locator('#mp4').evaluate((v: HTMLVideoElement) => Math.abs(v.currentTime - 1.5))).toBeLessThan(.1);
    await frame.getByRole('button', { name: 'Play WebM', exact: true }).click();
    await expect.poll(() => frame.locator('#webm').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.1);
    const mediaUrl = await frame.locator('#mp4').getAttribute('src');
    const ranges = await app.evaluate(async ({ net }, url) => {
      const partial = await net.fetch(url, { headers: { Range: 'bytes=10-39' } });
      const denied = await net.fetch(url.replace(/media\/[a-f0-9]{64}/, 'media/' + '0'.repeat(64)));
      return { status: partial.status, size: (await partial.arrayBuffer()).byteLength, acceptRanges: partial.headers.get('accept-ranges'), unlisted: denied.status };
    }, mediaUrl!);
    expect(ranges).toEqual({ status: 206, size: 30, acceptRanges: 'bytes', unlisted: 404 });
    const saved = join(seed.root, 'saved.html');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog; }, saved);
    await gui.getByRole('button', { name: 'Save ↓' }).click();
    await expect.poll(() => { try { return readFileSync(saved, 'utf8'); } catch { return ''; } }).toContain('saved.assets/');
    expect(readdirSync(join(seed.root, 'saved.assets')).length).toBe(3);
    // Validate the portable export in a hidden sandboxed Electron window, never an external browser.
    const exportedWindow = app.waitForEvent('window');
    await app.evaluate(async ({ BrowserWindow }, file) => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await window.loadFile(file);
    }, saved);
    const exported = await exportedWindow;
    await ready(exported.locator('#mp4')); await ready(exported.locator('#dynamic'));
    await exported.close();
    await gui.getByRole('button', { name: 'Open in browser', exact: true }).click();
    await expect.poll(() => { try { return readFileSync(join(seed.root, 'e2e-open-external.log'), 'utf8'); } catch { return ''; } }).toMatch(/file:.*artifact-previews.*\.html/);
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    for (const format of ['mp4', 'webm']) rmSync(join(seed.projectDir, 'clip.' + format));
    await page.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await ready(gui.frameLocator('iframe[title="Local video"]').locator('#mp4'));
    await ready(gui.frameLocator('iframe[title="Local video"]').locator('#webm'));
    const reloaded = gui.frameLocator('iframe[title="Local video"]');
    await reloaded.locator('#mp4').evaluate((v: HTMLVideoElement) => { v.src = 'https://blocked.invalid/clip.mp4'; v.load(); });
    await expect(reloaded.getByRole('alert').filter({ hasText: 'media URL is blocked' })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('TUI HTML resolves video beside its input file and plays in the isolated preview', async ({ app, seeded }) => {
  prepare(seeded.projectDir);
  // No JS-declared asset here: both static video paths should attach automatically.
  writeFileSync(join(seeded.projectDir, 'reports/video.html'), html.split('<video id="dynamic"')[0]);
  await (await app.firstWindow()).waitForLoadState('domcontentloaded');
  await run(resolve('bin/aya'), ['present', '--title', 'TUI video', '--html', join(seeded.projectDir, 'reports/video.html')], {
    cwd: seeded.projectDir,
    env: { ...process.env, AYA_SOCKET: join(seeded.ayaHome, 'aya.sock'), AYA_HOME: seeded.ayaHome, AYA_TERMINAL_ID: '', AYA_PRESET_ID: '' },
  });
  await expect.poll(() => app.windows().some(p => decodeURIComponent(p.url()).includes('<title>TUI video</title>'))).toBe(true);
  const preview = app.windows().find(p => decodeURIComponent(p.url()).includes('<title>TUI video</title>'))!;
  const frame = preview.frameLocator('iframe');
  await ready(frame.locator('#webm'));
  await frame.getByRole('button', { name: 'Play WebM', exact: true }).click();
  await expect.poll(() => frame.locator('#webm').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.1);
});
