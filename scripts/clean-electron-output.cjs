// Remove compiler output, retaining native helpers which have their own build steps.
const fs = require('node:fs');
const path = require('node:path');
function clean(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) clean(file);
    else if (/\.(?:js|js\.map|d\.ts|tsbuildinfo)$/.test(entry.name)) fs.unlinkSync(file);
  }
}
clean(path.join(__dirname, '..', 'dist-electron'));
