import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';

test.use({ seedOptions: { fakeHome: true, fakeBins: ['agy'] } });

for (const layout of ['classic', 'projects-left']) {
test(`Antigravity ring (${layout}) shows the most-used limit with separate model pools`, async ({ app, window, seeded }) => {
  const end = new Date(Date.now() + 86400_000).toISOString();
  const bucket = (window: string, remaining_fraction: number) => ({ window, remaining_fraction, reset_time: end });
  const data = { status: 'SUCCESS', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [bucket('weekly', .21), bucket('5h', .99)] },
    { name: 'Claude and GPT models', buckets: [bucket('weekly', 1), bucket('5h', .1)] },
  ] } } };
  const bin = join(seeded.root, 'fake-bin');
  writeFileSync(join(bin, 'agy'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(data))});\n`, { mode: 0o755 });
  await app.evaluate((_main, bin) => { process.env.PATH = bin + ':' + process.env.PATH; }, bin);
  await window.evaluate(async () => {
    const presets = await window.aya.listPresets();
    await window.aya.savePresets([...presets, { id: 'antigravity', name: 'Antigravity', icon: 'a', color: '', agent: 'antigravity', command: 'agy' }]);
  });
  await window.evaluate((layout) => {
    localStorage.setItem('aya:layout-mode', layout);
  }, layout);
  await window.reload();
  const chip = window.getByRole('button', { name: 'Antigravity usage, account-wide' });
  await expect(chip).toContainText('90%', { timeout: 15_000 });
  await expect(chip).toHaveAttribute('title', /most-used limit/);
  await chip.click();
  const menu = window.getByRole('menu').filter({ hasText: 'Antigravity' });
  await expect(menu).toContainText('2 quota groups');
  await expect(menu).toContainText('Gemini Models');
  await expect(menu).toContainText('Claude and GPT models');
  await expect(menu).toContainText('79%');
  await expect(menu).toContainText('week');
  await expect(menu).toContainText('5h');
  await expect(menu).toContainText('resets');
  await expect(menu).not.toContainText('2 accounts');
});

}
