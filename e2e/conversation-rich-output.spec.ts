import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedCodexGui } from './helpers/codex-gui';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRc8AAAAASUVORK5CYII=';
const fence = (language: string, source: string) => `\n\n\`\`\`${language}\n${source}\n\`\`\`\n\n`;

test('conversation highlights and copies code, displays local and embedded images, and enlarges them', async () => {
  const seed = seedCodexGui();
  const image = join(seed.projectDir, 'image with spaces.png');
  const temporaryImage = join(seed.root, 'temporary image.png');
  writeFileSync(image, Buffer.from(png, 'base64'));
  writeFileSync(temporaryImage, Buffer.from(png, 'base64'));
  writeFileSync(join(seed.projectDir, 'animated.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  writeFileSync(join(seed.projectDir, 'inline-output.md'), [
    'Inline `const value = 3` remains inline.',
    fence('ts', 'const value: string = "Aya";\nconsole.log(value);'),
    fence('unknown-language', '<script>window.injected = true</script>'),
    fence('', 'unlabelled code'),
    `![Relative](image%20with%20spaces.png)`,
    `![Absolute](<${image}>)`,
    `![File URL](${pathToFileURL(image).href})`,
    `![Temporary](<${temporaryImage}>)`,
    `[Linked temporary](<${temporaryImage}>)`,
    `[**Styled link**](<${image}>)`,
    `![Embedded](data:image/png;base64,${png})`,
    '![Animated](animated.gif)',
    '![Missing](missing.png)',
    '![Remote](https://example.com/tracker.png)',
    '[External link](https://example.com/) · [Unsafe](javascript:alert(1))',
  ].join('\n\n'));
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    const requests: string[] = [];
    window.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    await window.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (value: string) => { (window as unknown as { copied: string }).copied = value; } });
    });
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('inline-output'); await prompt.press('Enter');
    const blocks = gui.locator('.aya-chat-code');
    await expect(blocks).toHaveCount(3);
    await expect(blocks.first().locator('.hljs-keyword')).toContainText(['const']);
    await expect(blocks.nth(1).locator('code')).toHaveText('<script>window.injected = true</script>');
    await expect(gui.locator('p > code')).toHaveText('const value = 3');
    await blocks.first().getByRole('button', { name: 'Copy code' }).click();
    await expect(blocks.first().getByRole('button', { name: 'Copy code' })).toHaveText('Copied');
    expect(await window.evaluate(() => (window as unknown as { copied: string }).copied)).toBe('const value: string = "Aya";\nconsole.log(value);');
    for (const alt of ['Relative', 'Absolute', 'File URL', 'Temporary', 'Linked temporary', 'Embedded', 'Animated']) {
      const img = gui.getByRole('img', { name: alt, exact: true });
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    await expect(gui.getByRole('alert').filter({ hasText: 'missing.png' })).toContainText('Cannot display');
    await expect(gui.getByText('Linked temporary', { exact: true })).toBeVisible();
    await expect(gui.getByRole('link', { name: 'Styled link' })).toBeVisible();
    await expect(gui.getByRole('alert').filter({ hasText: 'tracker.png' })).toContainText('inside the workspace');
    expect(requests).toEqual([]);
    expect(await window.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
    await expect(gui.getByRole('link', { name: 'Unsafe', exact: true })).toHaveCount(0);
    await expect(gui.getByRole('link', { name: 'External link', exact: true })).toHaveAttribute('href', 'https://example.com/');
    await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toHaveCount(0);
    const enlarge = gui.getByRole('button', { name: 'Enlarge image: Relative', exact: true });
    await enlarge.click();
    await expect(window.getByRole('dialog', { name: 'Relative' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'Relative' })).toHaveCount(0);
    await expect(enlarge).toBeFocused();
    // Missing images can recover in place.
    writeFileSync(join(seed.projectDir, 'missing.png'), Buffer.from(png, 'base64'));
    await gui.getByRole('alert').filter({ hasText: 'missing.png' }).getByRole('button', { name: 'Retry' }).click();
    await expect(gui.getByRole('img', { name: 'Missing', exact: true })).toBeVisible();
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    await window.reload();
    await expect(gui.locator('.aya-chat-code .hljs-keyword').first()).toHaveText('const');
    await expect(gui.getByRole('img', { name: 'Embedded', exact: true })).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('conversation renders graphs and charts locally and retains copyable sources after reload', async () => {
  const seed = seedCodexGui();
  writeFileSync(join(seed.projectDir, 'inline-output.md'), [
    '# Inline visuals',
    fence('mermaid', 'flowchart LR\n A[Start] --> B[Done]\n click A "https://example.com/" "Click"'),
    fence('mermaid', 'sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Hi'),
    fence('mermaid', 'pie title Time\n "Coding" : 70\n "Review" : 30'),
    fence('mermaid', 'xychart-beta\n title "Builds"\n x-axis [Mon, Tue, Wed]\n y-axis "Count" 0 --> 20\n bar [8, 12, 17]\n line [7, 11, 14]'),
    fence('mermaid', 'flowchart LR\n A['),
  ].join('\n'));
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    const requests: string[] = [];
    const modules: string[] = [];
    window.on('request', request => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
      if (request.url().endsWith('.js')) modules.push(request.url());
    });
    await window.reload();
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.some(url => url.includes('mermaid.core'))).toBe(false);
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('inline-output'); await prompt.press('Enter');
    const diagrams = gui.locator('.aya-chat-diagram');
    await expect(diagrams).toHaveCount(5);
    for (let i = 0; i < 4; i++) {
      const img = diagrams.nth(i).getByRole('img');
      await expect(img).toBeVisible({ timeout: 20000 });
      await expect.poll(() => img.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    }
    await expect(diagrams.last().getByRole('status')).toContainText('Cannot preview');
    expect(modules.some(url => url.includes('mermaid.core'))).toBe(true);
    // Small graphs should use their intrinsic size, rather than stretching to
    // fill the entire chat pane. Large charts still shrink to fit the pane.
    expect(await diagrams.first().getByRole('img').evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(600);
    await expect(diagrams.last().locator('code')).toContainText('A[');
    await diagrams.first().getByRole('button', { name: 'Show source' }).click();
    await expect(diagrams.first().locator('code')).toContainText('A[Start] --> B[Done]');
    await diagrams.first().getByRole('button', { name: 'Hide source' }).click();
    await expect(diagrams.first().locator('code')).toHaveCount(0);
    await expect(gui.locator('.aya-chat-diagram svg, .aya-chat-diagram a, .aya-chat-diagram iframe')).toHaveCount(0);
    await expect(gui.getByRole('complementary', { name: 'Artifacts' })).toHaveCount(0);
    expect(requests).toEqual([]);
    await diagrams.first().getByRole('button', { name: 'Enlarge image: Mermaid diagram' }).click();
    await expect(window.getByRole('dialog', { name: 'Mermaid diagram' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'Mermaid diagram' })).toHaveCount(0);
    await expect(gui.getByRole('status', { name: 'Conversation save status' })).toHaveText('Saved locally');
    await window.screenshot({ path: 'test-results/conversation-rich-output.png' });
    await window.reload();
    await expect(gui.locator('.aya-chat-diagram img')).toHaveCount(4);
    await expect(gui.locator('.aya-chat-diagram').last().locator('code')).toContainText('A[');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test('an incomplete streaming diagram recovers when its final source arrives', async () => {
  const seed = seedCodexGui();
  writeFileSync(join(seed.projectDir, 'inline-output.md'), fence('mermaid', 'flowchart LR\n Start --> Finish'));
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow(), gui = window.locator('.aya-conversation');
    await expect(gui.locator('header').getByRole('status')).toHaveText('Ready');
    const prompt = gui.getByRole('textbox', { name: 'Message Codex' });
    await prompt.fill('inline-stream'); await prompt.press('Enter');
    await expect(gui.locator('.aya-chat-diagram img')).toBeVisible({ timeout: 20000 });
    await expect(gui.locator('.aya-chat-diagram').getByRole('status')).toHaveCount(0);
    await expect(gui.getByRole('status', { name: 'Turn status' })).toHaveText('Turn complete');
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
