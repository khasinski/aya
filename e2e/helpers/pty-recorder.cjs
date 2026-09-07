// A pane program that records the RAW bytes its PTY receives, one JSON line
// per chunk: {"t": <ms>, "b": <chunk>}. Raw mode is what makes it useful - the
// tty line discipline would otherwise hold input until a newline and hide the
// chunk boundaries, and chunk boundaries are exactly what the pane-send
// submit contract is about (the Enter must not ride along in the text's
// burst, or the agent TUIs read it as a pasted newline).
//
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

// Readiness is signalled by creating the log file, not by printing: the spec
// polls for the file. Written only after stdin is being read, so a test never
// writes into a pane that would drop the bytes.
fs.writeFileSync(out, "");
