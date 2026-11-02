import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';

test.use({ seedOptions: { gitRepo: true, split: false, singleTab: true, presetList: [{ id: 'shell', name: 'Shell', icon: '$', color: '', command: 'cat' }] } });
async function checkFocusCycle(page: Page, dialog: Locator) {
  const endpoints = await dialog.evaluate(root => {
    const nodes = [...root.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(node => node.getClientRects().length && !node.closest('[inert],[aria-hidden="true"]'));
    nodes.at(-1)!.focus(); return { first: nodes[0].outerHTML, last: nodes.at(-1)!.outerHTML };
  });
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(root => root.contains(document.activeElement) && document.activeElement?.outerHTML)).toBe(endpoints.first);
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(root => document.activeElement?.outerHTML)).toBe(endpoints.last);
  // Programmatic focus from a background pane is also redirected into the modal.
  await page.locator('.xterm-helper-textarea').first().evaluate((node: HTMLElement) => node.focus());
  expect(await dialog.evaluate(root => root.contains(document.activeElement))).toBe(true);
}
test('worktree and project dialogs share focus containment, Escape and opener restoration', async ({ window }) => {
  const opener = window.locator('.aya-worktree-add'); await opener.focus(); await opener.click();
  const dialog = window.getByRole('dialog', { name: 'Start in worktrees' });
  await expect(dialog).toBeVisible(); await checkFocusCycle(window, dialog);
  await window.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  const settingsOpener = window.getByRole('button', { name: 'Settings' }); await settingsOpener.click();
  const settings = window.getByRole('dialog', { name: 'Settings' });
  await checkFocusCycle(window, settings);
  await window.keyboard.press('Escape'); await expect(settings).toHaveCount(0);
  await expect(settingsOpener).toBeFocused();
});
