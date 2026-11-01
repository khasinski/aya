import { test, expect, launchApp, closeAndWait } from './fixtures';
import { seedEnv } from './helpers/seed';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
test('usage shows local token trends, model filters and separate account limits', async () => {
  const seed = seedEnv({ singleTab: { presetId: 'shell', name: 'Shell' }, codexRateLimits: { primary: { used_percent: 38, resets_at: Math.floor(Date.now() / 1000) + 3600, window_minutes: 300 }, secondary: { used_percent: 72, resets_at: Math.floor(Date.now() / 1000) + 86400, window_minutes: 10080 } } });
  const home = join(seed.root, 'codex-home'); mkdirSync(join(home, 'sessions'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(home, 'sessions', 'token-history.jsonl'), [
    { type: 'turn_context', payload: { model: 'test-codex-model' } },
    { timestamp: now, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10000, cached_input_tokens: 4000, output_tokens: 2000, reasoning_output_tokens: 500 } } } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const claudeHome = join(seed.root, 'history-claude'); mkdirSync(join(claudeHome, 'projects', 'project'), { recursive: true });
  writeFileSync(join(claudeHome, 'projects', 'project', 'session.jsonl'), JSON.stringify({ timestamp: now, type: 'assistant', message: { id: 'test-message', model: 'test-claude-model', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 } } }));
  seed.launchEnv = { CLAUDE_CONFIG_DIR: claudeHome, GROK_HOME: join(seed.root, 'history-grok') };
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: 'Open usage', exact: true }).click();
    const usage = window.getByRole('dialog', { name: 'Usage', exact: true });
    await expect(usage).toBeVisible();
    await expect(usage.getByRole('heading', { name: 'Tokens over time' })).toBeVisible();
    await expect(usage.getByRole('table')).toContainText('test-codex-model');
    await expect(usage.getByRole('table')).toContainText('test-claude-model');
    await expect(usage.locator('.aya-usage-metrics article').first()).toContainText('15.5K');
    await usage.getByRole('combobox', { name: 'Usage provider' }).selectOption('codex');
    await expect(usage.getByRole('table')).not.toContainText('test-claude-model');
    await expect(usage.locator('.aya-usage-metrics article').first()).toContainText('12K');
    const bar = usage.locator('.aya-usage-bars button').last();
    await bar.focus();
    await expect(usage.locator('.aya-usage-chart-readout')).toContainText('12,000 tokens');
    await usage.getByRole('button', { name: 'Reset filters' }).click();
    await usage.getByRole('tab', { name: 'Limits', exact: true }).click();
    await expect(usage.locator('.aya-usage-limit-grid')).toContainText('38% used');
    await expect(usage.locator('.aya-usage-limit-grid')).toContainText('72% used');
    await usage.getByRole('tab', { name: 'Tokens', exact: true }).click();
    await usage.getByRole('button', { name: '30 days', exact: true }).click();
    await expect(usage.getByRole('button', { name: '30 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(usage.getByRole('button', { name: 'Refresh usage' })).toBeEnabled();
    await expect(usage.getByRole('table')).toContainText('test-codex-model');
    await window.screenshot({ path: 'test-results/usage-dashboard.png' });
    await usage.getByRole('button', { name: 'Close usage' }).press('Escape');
    await expect(usage).toHaveCount(0);
    await expect(window.locator('.aya-pane:visible .xterm-helper-textarea')).toBeFocused();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
