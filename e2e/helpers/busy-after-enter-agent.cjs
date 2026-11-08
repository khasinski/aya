// Offline stand-in for a Claude pane: idle composer, then "working" for a while after Enter, then idle again.
const WORK_MS = Number(process.argv[2] || 2000);
const idle = '\x1b[2J\x1b[H❯ \r\n? for shortcuts\r\n';
const busy = '\x1b[2J\x1b[H❯ \r\n  esc to interrupt\r\n';
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write(idle);
let working = false;
process.stdin.on('data', (chunk) => {
  if (working || !String(chunk).includes('\r')) return;
  working = true;
  process.stdout.write(busy);
  setTimeout(() => { working = false; process.stdout.write(idle); }, WORK_MS);
});
setInterval(() => {}, 1000);
