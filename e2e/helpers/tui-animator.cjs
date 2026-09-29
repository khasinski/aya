// A pane program shaped like Grok: a full-screen TUI whose logo animates. The
// raw PTY tail soon holds only animation frames; the one text line is painted
// once. Usage: node tui-animator.cjs <readyfile>
const fs = require("node:fs");

const ready = process.argv[2];
const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let sent = 0;
let i = 0;

process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J\x1b[3;1Hanimator says hello\r\n> prompt");
const timer = setInterval(() => {
  let burst = "";
  for (let n = 0; n < 200; n += 1, i += 1) {
    burst += `\x1b[1;1H\x1b[36m${frames[i % frames.length].repeat(12)}\x1b[0m`;
  }
  process.stdout.write(burst);
  sent += burst.length;
  // Well past the 64 KB a raw pane read returns: the text line is out of it.
  if (sent > 256_000 && !fs.existsSync(ready)) fs.writeFileSync(ready, "");
}, 20);
process.on("SIGHUP", () => clearInterval(timer));
