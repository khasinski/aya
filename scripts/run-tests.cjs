const { availableParallelism } = require('node:os');
const { spawnSync } = require('node:child_process');

// Reserve a CPU for the OS and the real child processes these tests launch.
// Large workstations benefit from eight files at once; small CI runners need
// Node's usual CPU-based limit to avoid starving process and timer tests.
const concurrency = Math.min(8, Math.max(1, availableParallelism() - 1));
console.log(`Running tests with ${concurrency} parallel files`);
const result = spawnSync(process.execPath, [
  '--import', './tests/helpers/preload-guard.mjs',
  '--test', `--test-concurrency=${concurrency}`,
  ...process.argv.slice(2), 'tests/**/*.test.mjs',
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
