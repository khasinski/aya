import { test, expect } from './fixtures';
import { fireShortcut } from './helpers/shortcut';

for (const label of ['Command Rail', 'Command Rail, projects left']) {
  test(`${label} is optional, persists and switches back to Classic`, async ({ app, window }) => {
    await expect(window.locator('.aya-app')).not.toHaveAttribute('data-chrome', 'command-rail');
    await fireShortcut(app, 'open-settings');
    const settings = window.locator('.aya-modal--settings');
    await settings.locator('[aria-label="Window layout"]').getByRole('button', { name: label, exact: true }).click();
    await window.keyboard.press('Escape');
    await expect(window.locator('.aya-app')).toHaveAttribute('data-chrome', 'command-rail');
    await expect(window.locator('.aya-cr')).toBeVisible();
    await expect(window.getByRole('main', { name: 'Terminal workspace' })).toHaveCount(1);
    await window.reload();
    await expect(window.locator('.aya-app')).toHaveAttribute('data-chrome', 'command-rail');
    await expect(window.locator('.aya-cr')).toBeVisible();
    await fireShortcut(app, 'open-settings');
    await settings.locator('[aria-label="Window layout"]').getByRole('button', { name: 'Projects on top', exact: true }).click();
    await window.keyboard.press('Escape');
    await expect(window.locator('.aya-cr')).toHaveCount(0);
    await expect(window.locator('.aya-app')).not.toHaveAttribute('data-chrome', 'command-rail');
    await expect(window.getByRole('navigation', { name: 'Terminals', exact: true })).toBeVisible();
  });
}
