const fs = require("node:fs");
const [mode, log] = process.argv.slice(2);

if (mode === "hold") {
  process.stdout.write([
    "Read outside the working directories",
    "Allow this read outside the working directories?",
    "❯ 1. Yes",
    "keep allowing any reads outside the working directories",
    "  2. No",
    "block reads outside the working directories from now on",
    "  3. No, and ask again next time",
    "  4. Yes, but ask again next time",
    "Esc to cancel · Tab to amend",
    "",
  ].join("\r\n"));
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => fs.appendFileSync(log, chunk));
fs.writeFileSync(`${log}.ready`, "ready");
