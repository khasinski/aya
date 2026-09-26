// A pane program that records how it was launched: its argv and whether `aya`
// resolves on its PATH. Then it idles, like an agent waiting for input.
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
fs.writeFileSync(
  out,
  JSON.stringify({
    args,
    ayaOnPath: ayaOnPath || null,
    pathEntries: (process.env.PATH || "").split(path.delimiter),
  }),
);
setInterval(() => {}, 60_000);
