// Stands in for codex-cli 0.158.0's session store (state_5 / logs_2 sqlite); FAKE_CODEX_STORE=off leaves the pid
// out of the logs (a codex Aya cannot read). Usage: node fake-codex.cjs <outfile> [resume --last | resume <id>]
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// Aya puts --no-daemon right after the binary, and asks `codex --help` whether it exists;
// real codex answers that without touching its store.
const argv = process.argv.slice(2);
if (argv[0] === "--help") {
  process.stdout.write("      --no-daemon\n");
  process.exit(0);
}
const [out, ...args] = argv[0] === "--no-daemon" ? argv.slice(1) : argv;
const home = process.env.CODEX_HOME;
fs.mkdirSync(home, { recursive: true });
const cwd = fs.realpathSync(process.cwd());
const open = (name, schema) => {
  const db = new DatabaseSync(path.join(home, name));
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(schema);
  return db;
};
const state = open(
  "state_5.sqlite",
  "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, source TEXT NOT NULL, thread_source TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)",
);
const logs = open(
  "logs_2.sqlite",
  "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, thread_id TEXT, process_uuid TEXT)",
);
const touch = state.prepare("INSERT INTO threads VALUES (?, ?, 'cli', 'user', ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms");
if (process.env.FAKE_CODEX_PRIOR) {
  process.env.FAKE_CODEX_PRIOR.split(",").forEach((id, i) => touch.run(id, cwd, 1000 + i, 1000 + i));
}
const newest = state.prepare("SELECT id FROM threads WHERE cwd = ? ORDER BY updated_at_ms DESC LIMIT 1");

let session = null;
if (args[0] === "resume") session = args[1] === "--last" ? (newest.get(cwd)?.id ?? null) : args[1];
const resumed = session;
if (args[0] === "resume" && args[1] !== "--last" && !state.prepare("SELECT 1 FROM threads WHERE id = ?").get(session)) {
  fs.appendFileSync(out, `${JSON.stringify({ args, resumed: null, session: null, pid: process.pid })}\n`);
  process.stderr.write(`ERROR: No saved session found with ID ${session}\n`);
  process.exit(1);
}
session ??= crypto.randomUUID();
const now = Date.now();
touch.run(session, cwd, now, now);
if (process.env.FAKE_CODEX_STORE !== "off") {
  logs.prepare("INSERT INTO logs (ts, thread_id, process_uuid) VALUES (?, ?, ?)").run(Math.floor(now / 1000), session, `pid:${process.pid}:${crypto.randomUUID()}`);
}
fs.appendFileSync(out, `${JSON.stringify({ args, resumed, session, pid: process.pid })}\n`);
process.stdout.write("fake codex ready\n");
setInterval(() => {}, 60_000);
