// Stands in for claude: registers sessions/<pid>.json under CLAUDE_CONFIG_DIR
// and saves a transcript like the real CLI, appends each launch to <outfile>,
// then idles.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [out, ...args] = process.argv.slice(2);
const sessionId = crypto.randomUUID();
const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, "sessions");
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(
  path.join(sessions, `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd() }),
);
// Real claude saves projects/<cwd with non-alphanumerics as "-">/<id>.jsonl.
const project = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), "{}\n");
fs.appendFileSync(out, `${JSON.stringify({ args, sessionId, pid: process.pid })}\n`);
process.stdout.write("fake claude ready\n");
setInterval(() => {}, 60_000);
