// A pane program that logs the raw PTY chunks it receives, one JSON line each.
// Raw mode keeps the chunk boundaries the pane-send submit contract is about.
// Usage: node pty-recorder.cjs <outfile>
const fs = require("node:fs");

const out = process.argv[2];
if (!out) {
  console.error("pty-recorder: outfile argument is required");
  process.exit(1);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  fs.appendFileSync(
    out,
    `${JSON.stringify({ t: Date.now(), b: chunk.toString("utf8") })}\n`,
  );
});
process.stdin.resume();

// Creating the file IS the readiness signal, and only after stdin is read.
fs.writeFileSync(out, "");
