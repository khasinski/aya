// Records how the pane was launched, then idles like an agent waiting for input.
// Usage: node argv-dump.cjs <outfile> [args...]
const fs = require("node:fs");
const path = require("node:path");

const [out, ...args] = process.argv.slice(2);
const ayaOnPath = (process.env.PATH || "")
  .split(path.delimiter)
  .map((dir) => path.join(dir, "aya"))
  .find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
// Atomic: a reader polling for the file must never see it half written.
fs.writeFileSync(
  `${out}.tmp`,
  JSON.stringify({
    args,
    ayaOnPath: ayaOnPath || null,
    pathEntries: (process.env.PATH || "").split(path.delimiter),
    opencodeConfigContent: process.env.OPENCODE_CONFIG_CONTENT ?? null,
    opencodeConfig: process.env.OPENCODE_CONFIG ?? null,
  }),
);
fs.renameSync(`${out}.tmp`, out);
setInterval(() => {}, 60_000);
