import { test, expect } from './fixtures';
import { reloadInProjectsLeftLayout } from './helpers/layout';

for (const layout of ['classic', 'projects-left']) {
  test(`macOS ${layout}: reserve native controls when windowed, render Aya controls when fullscreen`, async ({ app, window }) => {
    test.skip(process.platform !== 'darwin', 'macOS window controls');
    if (layout === 'projects-left') await reloadInProjectsLeftLayout(window);
    const space = window.locator('.aya-native-window-controls-space');
    const controls = window.locator('.aya-mac-window-controls');
    await expect(space).toBeVisible();
    await expect(controls).toHaveCount(0);
    expect((await space.boundingBox())?.width).toBeGreaterThanOrEqual(80);
    // Exercise renderer state without showing a window or switching the user's
    // macOS Space. The native transition/visibility policy has separate tests.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:fullscreen', true));
    await expect(space).toHaveCount(0);
    await expect(controls.getByRole('button')).toHaveCount(3);
    await expect(controls.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:fullscreen', false));
    await expect(space).toBeVisible();
    await expect(controls).toHaveCount(0);
  });
}
