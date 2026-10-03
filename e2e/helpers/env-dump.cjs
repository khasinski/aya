// Records this process's env and argv into <dir>/run-<n>.json, then exits 0.
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const n = fs.readdirSync(dir).filter((f) => f.startsWith("run-")).length + 1;
// Written whole, then renamed: the test reads the file the moment it exists.
fs.writeFileSync(path.join(dir, `.run-${n}.tmp`), JSON.stringify({ argv: process.argv.slice(3), env: process.env }));
fs.renameSync(path.join(dir, `.run-${n}.tmp`), path.join(dir, `run-${n}.json`));
process.stdout.write("dumped\n");
