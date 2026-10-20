// Minimal PTY target for the real `aya pane send` user-rule boundary test.
// It displays a user-defined account prompt and records every received byte.
const fs = require("node:fs");

const receivedPath = process.argv[2];
if (!receivedPath) throw new Error("received-byte log path is required");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("LOCAL_ACCOUNT_PROMPT\r\nAllow this account change?\r\n");
fs.writeFileSync(receivedPath, "");
process.stdin.on("data", (chunk) => fs.appendFileSync(receivedPath, chunk));
process.stdin.resume();
