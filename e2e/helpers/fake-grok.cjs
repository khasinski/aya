// Stands in for grok 1.0.44's session store (active_sessions.json, sessions/<cwd>/<id>/); FAKE_GROK_UNSAVED=1
// skips the folder, as grok does until the first message. Usage: node fake-grok.cjs <outfile> [grok flags]
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [out, ...args] = process.argv.slice(2);
const home = process.env.GROK_HOME;
const cwd = fs.realpathSync(process.cwd());
const after = (flag) => args[args.indexOf(flag) + 1];
const resumed = args.includes("--resume") ? after("--resume") : null;
const session = resumed ?? (args.includes("--session-id") ? after("--session-id") : crypto.randomUUID());
const dir = path.join(home, "sessions", encodeURIComponent(cwd), session);
if (resumed && !fs.existsSync(dir)) {
  fs.appendFileSync(out, `${JSON.stringify({ args, resumed: null, session: null, pid: process.pid })}\n`);
  process.stderr.write(`session ${session} not found\n`);
  process.exit(1);
}
if (process.env.FAKE_GROK_UNSAVED !== "1") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ info: { id: session, cwd } }));
}

fs.mkdirSync(home, { recursive: true });
const registry = path.join(home, "active_sessions.json");
const lock = `${registry}.lock`;
for (;;) {
  try {
    fs.mkdirSync(lock);
    break;
  } catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
let rows = [];
try {
  rows = JSON.parse(fs.readFileSync(registry, "utf8"));
} catch {}
rows.push({ session_id: session, pid: process.pid, cwd, opened_at: new Date().toISOString() });
fs.writeFileSync(registry, JSON.stringify(rows));
fs.rmdirSync(lock);

fs.appendFileSync(out, `${JSON.stringify({ args, resumed, session, pid: process.pid })}\n`);
process.stdout.write("fake grok ready\n");
setInterval(() => {}, 60_000);
