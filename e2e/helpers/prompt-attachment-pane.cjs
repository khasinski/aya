const fs = require("node:fs");
const readline = require("node:readline");

const log = process.argv[2];
const waiting = process.argv[3] === "hold";
process.stdout.write("ATTACHMENT_PANE_READY\n");
if (waiting) {
  process.stdout.write("\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n");
} else process.stdout.write("\r\n❯ \r\n? for shortcuts\r\n");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", (line) => {
  fs.appendFileSync(log, `${line}\n`, { mode: 0o600 });
  process.stdout.write(`\r\nREAD_BACK:${line}\r\n`);
});
