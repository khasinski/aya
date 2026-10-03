// Stands in for claude: registers sessions/<pid>.json under CLAUDE_CONFIG_DIR
// and saves a transcript like the real CLI, appends each launch to <outfile>,
// then idles. Like claude: nothing saved before the first message (FAKE_CLAUDE_UNSAVED=1), and its own
// sessions/<pid>.json only after the trust screen (FAKE_CLAUDE_LATE_MS, over a dead claude's FAKE_CLAUDE_LEFTOVER).
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [out, ...args] = process.argv.slice(2);
const named = args.find((a, i) => ["--session-id", "--resume"].includes(args[i - 1]));
const sessionId = named ?? crypto.randomUUID();
const project = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
const refuse = (message) => {
  fs.appendFileSync(out, `${JSON.stringify({ args, sessionId: null, pid: process.pid })}\n`);
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const saved = fs.existsSync(path.join(project, `${sessionId}.jsonl`));
if (args.includes("--resume") && !saved) refuse(`No conversation found with session ID: ${sessionId}`);
if (args.includes("--session-id") && saved) refuse(`Error: Session ID ${sessionId} is already in use.`);
const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, "sessions");
const register = (id, startedAt) => {
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), startedAt }));
  // Real claude saves projects/<cwd with non-alphanumerics as "-">/<id>.jsonl.
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), "{}\n");
};
const leftover = process.env.FAKE_CLAUDE_LEFTOVER;
if (leftover) {
  register(leftover, Date.now() - 3_600_000);
  setTimeout(() => register(sessionId, Date.now()), Number(process.env.FAKE_CLAUDE_LATE_MS));
} else if (process.env.FAKE_CLAUDE_UNSAVED !== "1") {
  register(sessionId, Date.now());
}
fs.appendFileSync(out, `${JSON.stringify({ args, sessionId, pid: process.pid })}\n`);
process.stdout.write("fake claude ready\n");
setInterval(() => {}, 60_000);
