const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const env = { ...process.env, AYA_E2E_HEADLESS: '1' }; delete env.CI;
for (const script of ['build', 'build:test-src']) {
  const result = spawnSync('npm', ['run', script], { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', 'e2e/gui-workload.spec.ts', '--workers=1'], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
