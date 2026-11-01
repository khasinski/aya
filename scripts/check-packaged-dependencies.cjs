// Executed by the packaged Electron binary as Node, so ASAR resolution is real.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
function checkPackagedDependencies(manifest) {
  manifest = fs.realpathSync(manifest);
  const root = path.dirname(manifest);
  const visited = new Set();
  function visit(file, chain) {
    if (visited.has(file)) return;
    visited.add(file);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const from = createRequire(file);
    for (const name of Object.keys(pkg.dependencies || {})) {
      if (name in (pkg.optionalDependencies || {})) continue;
      let next;
      try {
        try { next = from.resolve(name + '/package.json'); }
        catch {
          let dir = path.dirname(from.resolve(name));
          while (true) {
            const candidate = path.join(dir, 'package.json');
            if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === name) { next = candidate; break; }
            const parent = path.dirname(dir);
            if (parent === dir) throw Error('Package manifest not found');
            dir = parent;
          }
        }
        next = fs.realpathSync(next);
        if (!next.startsWith(root + path.sep) && !next.startsWith(root + '.unpacked' + path.sep)) throw Error('Dependency resolved outside packaged app');
        const dependency = JSON.parse(fs.readFileSync(next, 'utf8'));
        if (dependency.main || dependency.exports) from.resolve(name);
      } catch (error) { throw Error(`Packaged dependency missing: ${[...chain, name].join(' -> ')} (${error.message})`); }
      visit(next, [...chain, name]);
    }
  }
  visit(path.resolve(manifest), []);
  return { packagedDependencies: 'passed', packages: visited.size };
}
exports.checkPackagedDependencies = checkPackagedDependencies;
if (require.main === module) {
  try { console.log(JSON.stringify(checkPackagedDependencies(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
