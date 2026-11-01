import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { checkPackagedDependencies } = require('../scripts/check-packaged-dependencies.cjs');
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'aya-package-deps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (relative, pkg) => { const dir = path.join(root, relative); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg)); writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};'); };
  add('', { name: 'aya', dependencies: { updater: '1' } });
  add('node_modules/updater', { name: 'updater', main: 'index.js', dependencies: { 'fs-extra': '1' } });
  return { root, add, manifest: path.join(root, 'package.json') };
}
test('packaging rejects missing transitive dependencies even when the direct dependency exists', t => {
  const { manifest } = fixture(t);
  assert.throws(() => checkPackagedDependencies(manifest), /updater -> fs-extra/);
});
test('packaging accepts complete nested dependencies and ignores absent optional dependencies', t => {
  const { manifest, add } = fixture(t);
  add('node_modules/updater/node_modules/fs-extra', { name: 'fs-extra', main: 'index.js', dependencies: { optional: '1' }, optionalDependencies: { optional: '1' } });
  assert.deepEqual(checkPackagedDependencies(manifest), { packagedDependencies: 'passed', packages: 3 });
});
test('packaging rejects a dependency with a missing runtime entry', t => {
  const { root, manifest, add } = fixture(t);
  add('node_modules/fs-extra', { name: 'fs-extra', main: 'missing.js' });
  rmSync(path.join(root, 'node_modules/fs-extra/index.js'));
  assert.throws(() => checkPackagedDependencies(manifest), /updater -> fs-extra/);
});
