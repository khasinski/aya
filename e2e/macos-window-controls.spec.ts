import { test, expect } from './fixtures';
import { reloadInProjectsLeftLayout } from './helpers/layout';

for (const layout of ['classic', 'projects-left']) {
  test(`macOS ${layout}: Aya controls remain visible when zooming and switching fullscreen`, async ({ app, window }) => {
    test.skip(process.platform !== 'darwin', 'macOS window controls');
    if (layout === 'projects-left') await reloadInProjectsLeftLayout(window);
    const controls = window.locator('.aya-mac-window-controls');
    await expect(controls.getByRole('button')).toHaveCount(3);
    await expect(controls.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
    const physicalWidth = () => controls.evaluate(element => element.getBoundingClientRect().width * window.devicePixelRatio);
    const before = await physicalWidth();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
    await expect.poll(physicalWidth).toBeGreaterThan(before * 1.4);
    // Exercise renderer state without showing a window or switching the user's
    // macOS Space. The native transition/visibility policy has separate tests.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:fullscreen', true));
    await expect(controls.getByRole('button')).toHaveCount(3);
    await expect(controls.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:fullscreen', false));
    await expect(controls.getByRole('button')).toHaveCount(3);
    await expect(controls.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
  });
}
