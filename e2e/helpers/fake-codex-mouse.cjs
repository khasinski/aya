// A tiny Codex stand-in that enables the terminal modes relevant to mouse
// scrolling, then emits enough history to evict those setup bytes from replay.
const { once } = require("node:events");

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("--no-daemon\n");
    return;
  }
  process.stdout.write("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h");
  const row = `${"x".repeat(98)}\r\n`;
  for (let i = 0; i < 11_000; i += 1) {
    if (!process.stdout.write(row)) await once(process.stdout, "drain");
  }
  process.stdout.write("\nFAKE_CODEX_MOUSE_READY\n");
  process.stdin.resume();
  setInterval(() => {}, 60_000);
}

void main();
