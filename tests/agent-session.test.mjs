// Which conversation a codex or grok pane is in, read from the CLI's own store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  pollSession,
  processFamily,
  restartGoneResume,
  readCodexSessionId,
  readGrokSessionId,
  canonicalDirs,
  sharesFolder,
  withLiveCodexResume,
  withLiveGrokResume,
  withOwnSessionId,
  withSharedDirCommand,
  LOG_CLOCK_SLACK_S,
} from "../dist-electron/agent-session.js";
import { withLiveClaudeResume } from "../dist-electron/claude-session.js";
import { commandWithBriefArg } from "../dist-electron/agent-brief.js";
import { ownSessionCommand } from "../dist-electron/opencode-session.js";

const scratch = () => realpathSync(mkdtempSync(path.join(tmpdir(), "agent-session-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const linkTo = (dir) => {
  const link = path.join(scratch(), "lnk");
  symlinkSync(dir, link);
  return link;
};
const upperCased = (dir) => dir.replace(/[a-z]+$/, (m) => m.toUpperCase());
const dead = async () => false;
function claudeTranscript(config, id) {
  const project = path.join(config, "projects", A.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, `${id}.jsonl`), "{}\n");
}

const codexHome = (opts) => writeCodex(scratch(), opts);
function writeCodex(home, { version = 5, threads = [], logs = [] }) {
  const state = new DatabaseSync(path.join(home, `state_${version}.sqlite`));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)");
  for (const [id, cwd, updated] of threads) state.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(id, cwd, updated);
  state.close();
  const db = new DatabaseSync(path.join(home, `logs_${version}.sqlite`));
  db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, thread_id TEXT, process_uuid TEXT, ts INTEGER)");
  for (const [thread, pid, ts = 1000] of logs) db.prepare("INSERT INTO logs (thread_id, process_uuid, ts) VALUES (?, ?, ?)").run(thread, `pid:${pid}:u`, ts);
  db.close();
  return home;
}

const A = scratch();
const B = scratch();
// Both CLIs take only a UUID as --session-id; anything else after --resume is a title.
const uid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const GONE = uid(1);
const HERE = uid(2);

test("codex: the thread of this cwd that this process logged to, whichever is newest", async () => {
  const home = codexHome({
    threads: [["mine", A, 100], ["sibling", A, 200], ["elsewhere", B, 300]],
    logs: [["mine", 11], ["sibling", 22], ["elsewhere", 11]],
  });
  assert.equal(await readCodexSessionId(home, A, [11], 0), "mine");
  assert.equal(await readCodexSessionId(home, A, [22], 0), "sibling");
  assert.equal(await readCodexSessionId(home, B, [11], 0), "elsewhere");
});

test("codex: a pid that logged to nothing, or to another cwd's thread only, finds nothing", async () => {
  const home = codexHome({ threads: [["t", A, 1]], logs: [["t", 11]] });
  assert.equal(await readCodexSessionId(home, A, [99], 0), null);
  assert.equal(await readCodexSessionId(home, B, [11], 0), null);
  assert.equal(await readCodexSessionId(home, A, [], 0), null);
});

test("codex: of several threads the pane's processes logged to in this cwd, the newest is its session", async () => {
  const home = codexHome({ threads: [["before-new", A, 100], ["after-new", A, 200], ["sibling", A, 300]], logs: [["before-new", 11], ["after-new", 11], ["sibling", 22]] });
  assert.equal(await readCodexSessionId(home, A, [11], 0), "after-new");
});

test("codex: any process of the family counts (the node launcher and its native child)", async () => {
  const home = codexHome({ threads: [["t", A, 1]], logs: [["t", 12]] });
  assert.equal(await readCodexSessionId(home, A, [11, 12], 0), "t");
});

test("codex: a pid that only prefixes the logging pid is not that process", async () => {
  const home = codexHome({ threads: [["t", A, 1]], logs: [["t", 123]] });
  assert.equal(await readCodexSessionId(home, A, [12], 0), null);
});

test("codex: a thread this process resumed counts, however old it is", async () => {
  const home = codexHome({
    threads: [["old", A, 1], ["newer", A, 50]],
    logs: [["old", 11], ["newer", 22]],
  });
  assert.equal(await readCodexSessionId(home, A, [11], 0), "old");
});

test("codex: a cwd reached through a symlink matches the physical cwd codex records", async () => {
  const home = codexHome({ threads: [["t", A, 1]], logs: [["t", 11]] });
  assert.equal(await readCodexSessionId(home, linkTo(A), [11], 0), "t");
});

test("codex: the newest schema version of each database is the one read", async () => {
  const home = codexHome({ version: 5, threads: [["v5", A, 1]], logs: [["v5", 11]] });
  writeCodex(home, { version: 10, threads: [["v10", A, 1]], logs: [["v10", 11]] });
  assert.equal(await readCodexSessionId(home, A, [11], 0), "v10");
});

test("codex: the pid is looked up first, so newer threads of the cwd cannot hide the pane's own", async () => {
  const threads = Array.from({ length: 25 }, (_, i) => [`t${i}`, A, i]);
  const home = codexHome({ threads, logs: [["t0", 11], ["t24", 22]] });
  assert.equal(await readCodexSessionId(home, A, [11], 0), "t0");
  assert.equal(await readCodexSessionId(home, A, [22], 0), "t24");
});

test("codex: an id that is not safe on a command line is never returned", async () => {
  const bad = "x; rm -rf ~";
  const home = codexHome({ threads: [[bad, A, 1]], logs: [[bad, 11]] });
  assert.equal(await readCodexSessionId(home, A, [11], 0), null);
});

test("codex: no databases (never run) is no session", async () => {
  assert.equal(await readCodexSessionId(scratch(), A, [11], 0), null);
});

function grokHome(rows, saved = []) {
  const home = scratch();
  writeFileSync(path.join(home, "active_sessions.json"), JSON.stringify(rows));
  for (const [cwd, id] of saved) mkdirSync(path.join(home, "sessions", encodeURIComponent(cwd), id), { recursive: true });
  return home;
}

test("grok: the session registered for the pid, once its folder is saved", async () => {
  const rows = [
    { session_id: "s-one", pid: 11, cwd: A },
    { session_id: "s-two", pid: 22, cwd: A },
  ];
  const home = grokHome(rows, [[A, "s-one"], [A, "s-two"]]);
  assert.equal(await readGrokSessionId(home, [11]), "s-one");
  assert.equal(await readGrokSessionId(home, [22]), "s-two");
  assert.equal(await readGrokSessionId(home, [33, 22]), "s-two");
  assert.equal(await readGrokSessionId(home, [33]), null);
});

test("grok: a session grok has not saved yet, or saved under another cwd, is not resumable", async () => {
  const rows = [{ session_id: "s-one", pid: 11, cwd: A }];
  assert.equal(await readGrokSessionId(grokHome(rows), [11]), null);
  assert.equal(await readGrokSessionId(grokHome(rows, [[B, "s-one"]]), [11]), null);
});

test("grok: an unsafe id, a row without a cwd, a non-list or missing registry is ignored; a corrupt one is an error", async () => {
  const bad = "x y";
  assert.equal(await readGrokSessionId(grokHome([{ session_id: bad, pid: 11, cwd: A }], [[A, bad]]), [11]), null);
  assert.equal(await readGrokSessionId(grokHome([{ session_id: "s", pid: 11 }], [["undefined", "s"]]), [11]), null);
  assert.equal(await readGrokSessionId(grokHome({ session_id: "s", pid: 11, cwd: A }), [11]), null);
  assert.equal(await readGrokSessionId(scratch(), [11]), null);
  const broken = scratch();
  writeFileSync(path.join(broken, "active_sessions.json"), "{not json");
  await assert.rejects(readGrokSessionId(broken, [11]));
});

test("pollSession reports every read that finds something, and none after stop", async () => {
  const seen = [];
  const reads = [null, "a", "a", "b"];
  const stop = pollSession(async () => reads.shift() ?? null, (id) => seen.push(id), 5);
  await sleep(80);
  stop();
  const count = seen.length;
  assert.deepEqual(seen, ["a", "a", "b"]);
  await sleep(30);
  assert.equal(seen.length, count);
});

test("pollSession drops a read that finishes after stop, and survives a failing read", async () => {
  const seen = [];
  let release;
  const slow = new Promise((r) => (release = r));
  const stop = pollSession(() => slow, (id) => seen.push(id), 5);
  await sleep(20);
  stop();
  release("late");
  await sleep(20);
  assert.deepEqual(seen, []);

  let calls = 0;
  const stop2 = pollSession(async () => {
    calls += 1;
    if (calls === 1) throw new Error("locked");
    return "ok";
  }, (id) => seen.push(id), 5);
  await sleep(40);
  stop2();
  assert.ok(seen.includes("ok"));
});

test("processFamily lists the pid and its descendants, and the pid alone when ps fails", async () => {
  const { spawn } = await import("node:child_process");
  const leaf = spawn("sleep", ["5"], { stdio: "ignore" });
  assert.deepEqual(await processFamily(leaf.pid), [leaf.pid]);
  leaf.kill();
  const child = spawn("sh", ["-c", "sleep 5 & wait"], { stdio: "ignore" });
  await sleep(300);
  const withChildren = await processFamily(process.pid);
  child.kill();
  assert.ok(withChildren.includes(child.pid));
  assert.ok(withChildren.length >= 3, `grandchild missing: ${withChildren}`);
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.deepEqual(await processFamily(process.pid), [process.pid]);
  } finally {
    process.env.PATH = saved;
  }
});

// --- a pid reused by a new pane must not inherit a dead process's thread ---

test("codex: a thread logged by an earlier process with the same pid is not this pane's", async () => {
  const home = codexHome({ threads: [["sibling", A, 500]], logs: [["sibling", 4242, 100]] });
  const spawnedAt = 200 * 1000;
  assert.equal(await readCodexSessionId(home, A, [4242], spawnedAt), null);
  assert.equal(await readCodexSessionId(home, A, [4242], 100 * 1000), "sibling");
});

test("codex: a log row up to LOG_CLOCK_SLACK_S before the spawn still counts, a second more does not", async () => {
  const LOGGED_S = 999;
  const home = codexHome({ threads: [["t", A, 1]], logs: [["t", 11, LOGGED_S]] });
  assert.equal(await readCodexSessionId(home, A, [11], (LOGGED_S + LOG_CLOCK_SLACK_S) * 1000), "t");
  assert.equal(await readCodexSessionId(home, A, [11], (LOGGED_S + LOG_CLOCK_SLACK_S + 1) * 1000), null);
});

const opened = (ms) => new Date(ms).toISOString();

test("grok: a row registered before this pane started is a dead process's, not this pane's", async () => {
  const rows = [{ session_id: "s-old", pid: 555, cwd: A, opened_at: opened(1000) }];
  const home = grokHome(rows, [[A, "s-old"]]);
  assert.equal(await readGrokSessionId(home, [555], 60_000), null);
  assert.equal(await readGrokSessionId(home, [555], 500), "s-old");
});

test("grok: of several rows for one pid the newest wins, so a stale row cannot shadow the live one", async () => {
  const rows = [
    { session_id: "s-old", pid: 555, cwd: A, opened_at: opened(1000) },
    { session_id: "s-new", pid: 555, cwd: A, opened_at: opened(90_000) },
  ];
  const home = grokHome(rows, [[A, "s-old"], [A, "s-new"]]);
  assert.equal(await readGrokSessionId(home, [555], 60_000), "s-new");
  assert.equal(await readGrokSessionId(home, [555], 0), "s-new");
});

// --- handles and failures ---

const openHandles = (file) => {
  try {
    const lines = execFileSync("lsof", ["-p", String(process.pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n");
    return lines.filter((line) => line.includes(file)).length;
  } catch {
    return null;
  }
};

test("codex: a database that cannot be opened does not leave the other one open", async (t) => {
  const home = codexHome({ threads: [["t", A, 1]], logs: [] });
  writeFileSync(path.join(home, "logs_9.sqlite"), "not a database");
  if (openHandles("state_5.sqlite") === null) return t.skip("lsof unavailable");
  for (let i = 0; i < 100; i += 1) await readCodexSessionId(home, A, [9], 0).catch(() => {});
  assert.equal(openHandles("state_5.sqlite"), 0);
});

test("codex: a database from an older schema is an error the caller can report, not an empty answer", async () => {
  const home = scratch();
  const state = new DatabaseSync(path.join(home, "state_4.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  state.close();
  const logs = new DatabaseSync(path.join(home, "logs_2.sqlite"));
  logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, thread_id TEXT, process_uuid TEXT, ts INTEGER)");
  logs.close();
  await assert.rejects(readCodexSessionId(home, A, [9], 0), /updated_at_ms/);
});

test("pollSession reports a failing read once per distinct error, and keeps polling", async () => {
  const errors = [];
  const seen = [];
  let calls = 0;
  const messages = ["locked", "locked", "schema", "schema", "locked"];
  const stop = pollSession(
    async () => {
      const message = messages[calls];
      calls += 1;
      if (message) throw new Error(message);
      return "ok";
    },
    (id) => seen.push(id),
    5,
    (err) => errors.push(err.message),
  );
  await sleep(120);
  stop();
  assert.deepEqual(errors, ["locked", "schema", "locked"]);
  assert.ok(seen.includes("ok"));
});

// --- a saved id whose session is gone must not leave the pane dead ---

test("codex: resume of a thread that no longer exists, or is archived, starts fresh", async () => {
  const home = codexHome({ threads: [["alive", A, 1]] });
  assert.equal(await withLiveCodexResume("codex resume alive", home), "codex resume alive");
  assert.equal(await withLiveCodexResume("codex resume gone", home), "codex");
  assert.equal(await withLiveCodexResume("X=1 codex --model m resume gone", home), "X=1 codex --model m");
  assert.equal(await withLiveCodexResume("codex resume --last", home), "codex resume --last");
  assert.equal(await withLiveCodexResume("codex", home), "codex");
  const archivedHome = scratch();
  const state = new DatabaseSync(path.join(archivedHome, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, updated_at_ms INTEGER, archived INTEGER)");
  state.prepare("INSERT INTO threads VALUES ('old', ?, 1, 1)").run(A);
  state.close();
  assert.equal(await withLiveCodexResume("codex resume old", archivedHome), "codex");
});

test("codex: no store at all means no thread; one that cannot be read leaves the resume alone and says so", async () => {
  const reported = [];
  assert.equal(await withLiveCodexResume("codex resume x", scratch(), (e) => reported.push(e)), "codex");
  assert.equal(reported.length, 0);
  const home = scratch();
  writeFileSync(path.join(home, "state_5.sqlite"), "not a database");
  assert.equal(await withLiveCodexResume("codex resume x", home, (e) => reported.push(e)), "codex resume x");
  assert.equal(reported.length, 1);
});

test("grok: --resume of a session whose folder is gone starts a new one under the same id", async () => {
  const home = grokHome([], [[A, HERE]]);
  assert.equal(await withLiveGrokResume(`grok --resume ${HERE}`, home, A), `grok --resume ${HERE}`);
  assert.equal(await withLiveGrokResume(`grok --resume ${GONE}`, home, A), `grok --session-id ${GONE}`);
  assert.equal(await withLiveGrokResume(`grok --model m --resume ${GONE}`, home, A), `grok --model m --session-id ${GONE}`);
  assert.equal(await withLiveGrokResume("grok", home, A), "grok");
  assert.equal(await withLiveGrokResume(`grok --resume ${HERE}`, home, linkTo(A)), `grok --resume ${HERE}`);
});

test("claude: a conversation with no transcript restarts under the same id, never --continue", async () => {
  const config = scratch();
  claudeTranscript(config, HERE);
  assert.equal(await withLiveClaudeResume(`claude --resume ${HERE}`, config, A), `claude --resume ${HERE}`);
  assert.equal(await withLiveClaudeResume(`claude --resume ${GONE}`, config, A), `claude --session-id ${GONE}`);
});

// --- a pane gets its own id at birth ---

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

test("a fresh launch of claude or grok is given a session id of its own", () => {
  const claude = withOwnSessionId("claude");
  assert.match(claude.command, new RegExp(`^claude --session-id ${UUID.source}$`));
  assert.equal(claude.sessionId, claude.command.split(" ")[2]);
  const env = withOwnSessionId('X=1 CLAUDE_CONFIG_DIR="$HOME/c" claude --model m');
  assert.match(env.command, new RegExp(`^X=1 CLAUDE_CONFIG_DIR="\\$HOME/c" claude --model m --session-id ${UUID.source}$`));
  assert.match(withOwnSessionId("grok").command, /^grok --session-id /);
  assert.notEqual(withOwnSessionId("claude").sessionId, withOwnSessionId("claude").sessionId);
});

test("a control character inside a quoted argument (the brief) does not stop a launch getting its id", () => {
  const brief = `claude --append-system-prompt 'Use \`aya\`; run a && b | c > d $(x)'`;
  const out = withOwnSessionId(brief);
  assert.equal(out.command, `${brief} --session-id ${out.sessionId}`);
  const dq = withOwnSessionId('claude --append-system-prompt "a; b \\" && c"');
  assert.ok(dq.sessionId);
  assert.equal(withOwnSessionId(`claude 'a' && echo b`).sessionId, null);
});

test("a launch that already resumes, names its session, or chains commands is left alone", () => {
  const untouched = [
    "claude --continue",
    "claude -c",
    "claude --resume abc",
    "claude --session-id abc",
    "claude --resume=abc",
    "grok --session-id=abc",
    "claude --fork-session",
    "claude && echo hi",
    "claude | tee log",
    "claude; echo hi",
    "claude > log",
    "claude $(pwd)",
    "",
  ];
  for (const command of untouched) {
    assert.deepEqual(withOwnSessionId(command), { command, sessionId: null }, command);
  }
  assert.deepEqual(withOwnSessionId("grok --resume x"), { command: "grok --resume x", sessionId: null });
});

// --- one folder, however it is spelled ---

test("sharesFolder: symlinks, trailing slashes and dot segments are one folder; other folders are not", async () => {
  const link = linkTo(A);
  assert.equal(await sharesFolder(A, [A]), true);
  assert.equal(await sharesFolder(A, [link]), true);
  assert.equal(await sharesFolder(link, [A]), true);
  assert.equal(await sharesFolder(A, [`${A}/`]), true);
  assert.equal(await sharesFolder(A, [`${A}/.`]), true);
  assert.equal(await sharesFolder(A, [path.join(A, "sub", "..")]), true);
  assert.equal(await sharesFolder(A, [B]), false);
  assert.equal(await sharesFolder(A, [path.join(A, "inner")]), false);
  assert.equal(await sharesFolder(A, []), false);
  assert.equal(await sharesFolder("/no/such/dir", ["/no/such/dir/"]), true);
});

test("sharesFolder: a folder differing only in letter case is the same on a case-insensitive disk", async (t) => {
  const upper = upperCased(A);
  if (!existsSync(upper)) return t.skip("case-sensitive filesystem");
  assert.equal(await sharesFolder(A, [upper]), true);
});

test("canonicalDirs: every spelling of a folder maps to one key, other folders to another", async () => {
  const link = linkTo(A);
  const [plain, viaLink, slash, dots, other] = await canonicalDirs([A, link, `${A}/`, path.join(A, "sub", "..", "."), B]);
  assert.equal(viaLink, plain);
  assert.equal(slash, plain);
  assert.equal(dots, plain);
  assert.notEqual(other, plain);
});

test("canonicalDirs: a folder that is gone keeps its own key, and a host:dir key is left alone", async () => {
  assert.deepEqual(await canonicalDirs(["/no/such/dir/", "me@host:/srv/app"]), ["/no/such/dir", "me@host:/srv/app"]);
});

test("canonicalDirs: letter case is one folder on a case-insensitive disk", async (t) => {
  const upper = upperCased(A);
  if (!existsSync(upper)) return t.skip("case-sensitive filesystem");
  const [a, b] = await canonicalDirs([A, upper]);
  assert.equal(a, b);
});

test("pollSession does not report an error from a read that fails after stop", async () => {
  const errors = [];
  let fail;
  const slow = new Promise((_, reject) => (fail = reject));
  const stop = pollSession(() => slow, () => {}, 5, (err) => errors.push(err.message));
  await sleep(20);
  stop();
  fail(new Error("late"));
  await sleep(20);
  assert.deepEqual(errors, []);
});

test("grok: a row opened a moment before the spawn timestamp still counts, one long before does not", async () => {
  const spawn = 100_000;
  const home = (ago) => grokHome([{ session_id: "s", pid: 5, cwd: A, opened_at: opened(spawn - ago) }], [[A, "s"]]);
  assert.equal(await readGrokSessionId(home(LOG_CLOCK_SLACK_S * 1000), [5], spawn), "s");
  assert.equal(await readGrokSessionId(home(LOG_CLOCK_SLACK_S * 1000 + 1), [5], spawn), null);
});

test("withSharedDirCommand: a peer in the same folder swaps the command; the extra fields never travel on", async () => {
  const link = linkTo(A);
  const req = (over) => ({ ptyId: "p", command: "codex resume --last", cwd: A, cols: 80, rows: 24, ...over });
  const shared = { sharedDirCommand: "codex", peerCwds: [link] };
  assert.deepEqual(await withSharedDirCommand(req(shared)), req({ command: "codex" }));
  assert.deepEqual(await withSharedDirCommand(req({ ...shared, peerCwds: [B] })), req({}));
  assert.deepEqual(await withSharedDirCommand(req({ peerCwds: [A] })), req({}));
  assert.deepEqual(await withSharedDirCommand(req({ sharedDirCommand: "codex" })), req({}));
  assert.deepEqual(await withSharedDirCommand(req({})), req({}));
});

// --- the brief and a team note are on the command the launch steps see ---

// What a real note looks like: an apostrophe (shellQuote writes it as '\'') and backticks.
const NOTE = "You are the tester in the user's team; run `aya team send` && report | done > now $(x)";
const briefed = (command, flag) => commandWithBriefArg(command, { kind: "arg", flag }, NOTE);

test("a command carrying a note with an apostrophe still gets its own id, on the end", () => {
  for (const [bin, flag] of [["claude", "--append-system-prompt"], ["grok", "--rules"]]) {
    const command = briefed(bin, flag);
    assert.match(command, /user'\\''s/);
    const out = withOwnSessionId(command);
    assert.ok(out.sessionId, `${bin}: ${command}`);
    assert.equal(out.command, `${command} --session-id ${out.sessionId}`);
  }
});

test("a resume carrying a note stays a resume, and one that names a session or chains is still left alone", () => {
  const resumed = briefed("claude --resume abc", "--append-system-prompt");
  assert.deepEqual(withOwnSessionId(resumed), { command: resumed, sessionId: null });
  const named = briefed("grok --session-id abc", "--rules");
  assert.deepEqual(withOwnSessionId(named), { command: named, sessionId: null });
  assert.equal(withOwnSessionId(`claude --append-system-prompt 'it'\\''s' && echo b`).sessionId, null);
  assert.equal(withOwnSessionId(`claude --append-system-prompt 'unclosed`).sessionId, null);
  assert.equal(withOwnSessionId('claude --append-system-prompt "unclosed').sessionId, null);
  assert.equal(withOwnSessionId('claude --append-system-prompt "a \\" b').sessionId, null);
  // A flag inside the note is text, not an option.
  const text = withOwnSessionId(`claude --append-system-prompt 'use --resume or -c if you must'`);
  assert.ok(text.sessionId);
});

// What the renderer builds for a remote project: the agent's command is inside the ssh line's quotes.
const remote = (inner) => `ssh -tt 'me@host' 'cd '\\''/srv/app'\\'' && exec "\${SHELL:-/bin/sh}" -l -i -c '\\''exec ${inner}'\\'''`;

test("a remote pane gets no id of its own: the transcript is on the other host and the flag would land on ssh", () => {
  for (const inner of ["claude", "grok", "claude --resume 11111111-1111-4111-8111-111111111111"]) {
    const command = remote(inner);
    assert.deepEqual(withOwnSessionId(command), { command, sessionId: null }, inner);
  }
  const plain = "ssh me@host claude";
  assert.deepEqual(withOwnSessionId(plain), { command: plain, sessionId: null });
});

test("only a command that starts with ssh is remote: a later word \"ssh\" is an argument", () => {
  const out = withOwnSessionId("claude --add-dir ssh");
  assert.equal(out.command, `claude --add-dir ssh --session-id ${out.sessionId}`);
  assert.ok(out.sessionId);
});

test("a remote pane keeps its --resume: a transcript Aya cannot see is not a gone one", async () => {
  for (const command of [remote(`claude --resume ${HERE}`), `ssh me@host claude --resume ${HERE}`, `ssh me@host claude --resume=${HERE}`]) {
    assert.equal(await restartGoneResume(command, dead), command, command);
  }
  assert.equal(await restartGoneResume(`claude --resume ${HERE}`, dead), `claude --session-id ${HERE}`);
});

test("claude: a stale id is restarted under the same id even with a note after the flag", async () => {
  const config = scratch();
  const command = briefed(`claude --resume ${GONE}`, "--append-system-prompt");
  const out = await withLiveClaudeResume(command, config, A);
  assert.equal(out, command.replace(`--resume ${GONE}`, `--session-id ${GONE}`));
  claudeTranscript(config, HERE);
  const alive = briefed(`claude --resume ${HERE}`, "--append-system-prompt");
  assert.equal(await withLiveClaudeResume(alive, config, A), alive);
});

test("grok: a session whose folder is gone is restarted under the same id even with a note after the flag", async () => {
  const home = scratch();
  const command = briefed(`grok --resume ${GONE}`, "--rules");
  assert.equal(await withLiveGrokResume(command, home, A), command.replace(`--resume ${GONE}`, `--session-id ${GONE}`));
  mkdirSync(path.join(home, "sessions", encodeURIComponent(A), HERE), { recursive: true });
  const alive = briefed(`grok --resume ${HERE}`, "--rules");
  assert.equal(await withLiveGrokResume(alive, home, A), alive);
});

test("grok: a session found under another folder name is not proof it is gone", async () => {
  const home = scratch();
  mkdirSync(path.join(home, "sessions", "some-other-encoding", HERE), { recursive: true });
  const command = `grok --resume ${HERE}`;
  assert.equal(await withLiveGrokResume(command, home, A), command);
  assert.equal(await withLiveGrokResume(`grok --resume ${GONE}`, home, A), `grok --session-id ${GONE}`);
});

test("claude: --resume=<id> followed by a note is rewritten alone, and an id that is not one is left as it is", async () => {
  const config = scratch();
  const inline = briefed(`claude --resume=${GONE}`, "--append-system-prompt");
  assert.equal(await withLiveClaudeResume(inline, config, A), inline.replace(`--resume=${GONE}`, `--session-id ${GONE}`));
  const odd = "claude --resume 'not an id' --model m";
  assert.equal(await withLiveClaudeResume(odd, config, A), odd);
  const bare = "claude --resume --model m";
  assert.equal(await withLiveClaudeResume(bare, config, A), bare);
});

// --- one rule for every rewrite: only a command that starts the agent itself is touched ---

const WRAPPERS = [
  "bash -lc 'exec AGENT'", "bash -c 'AGENT'", "sh -c 'AGENT'", "zsh -ic 'AGENT'",
  "env FOO=1 AGENT", "nohup AGENT", "time AGENT", "sudo -u bob AGENT", "docker exec -it c AGENT",
  "mosh h -- AGENT", "autossh -M 0 h AGENT", "tsh ssh h AGENT", "gcloud compute ssh h -- AGENT",
  "command ssh h AGENT", "/usr/bin/ssh h AGENT", "X=1 ssh h AGENT", "ssh h AGENT", "exec ssh h AGENT",
  "ssh -tt 'h' 'cd /srv && exec \"${SHELL:-/bin/sh}\" -l -i -c '\\''exec AGENT'\\'''",
];
const OTHER_PROGRAMS = ["claudette", "claude-wrapper --x", "my/claudex", "./notclaude", "xgrok", "codexd start"];
const DIRECT = ["AGENT", "X=1 AGENT", "X='a b' Y=2 AGENT", "exec AGENT", "X=1 exec AGENT", "/opt/bin/AGENT"];
const ID = "11111111-1111-4111-8111-111111111111";
const resumeOf = (agent, id) => (agent === "codex" ? `resume ${id}` : `--resume ${id}`);

test("wrapper commands: no birth id, no stale-id rewrite, for every agent and every id state", async () => {
  const home = scratch();
  for (const agent of ["claude", "grok", "codex", "opencode"]) {
    for (const template of WRAPPERS) {
      const cmd = (tail = "") => template.replace("AGENT", `${agent}${tail}`);
      assert.deepEqual(withOwnSessionId(cmd()), { command: cmd(), sessionId: null }, cmd());
      const stale = cmd(` ${resumeOf(agent, ID)}`);
      assert.equal(await restartGoneResume(stale, dead), stale, stale);
      if (agent === "codex") assert.equal(await withLiveCodexResume(stale, home), stale, stale);
      if (agent === "opencode") {
        const cont = cmd(" --continue");
        assert.equal(await ownSessionCommand(cont, A, async () => assert.fail(cont)), cont);
      }
    }
  }
});

test("a program whose name only starts with an agent's is not that agent", () => {
  for (const command of OTHER_PROGRAMS) assert.deepEqual(withOwnSessionId(command), { command, sessionId: null }, command);
});

test("direct commands: assignments, a plain exec and a path to the binary still get the id and the rewrite", async () => {
  const home = scratch();
  for (const agent of ["claude", "grok", "codex", "opencode"]) {
    for (const template of DIRECT) {
      const cmd = (tail = "") => template.replace("AGENT", `${agent}${tail}`);
      if (agent === "claude" || agent === "grok") {
        const out = withOwnSessionId(cmd());
        assert.equal(out.command, `${cmd()} --session-id ${out.sessionId}`, cmd());
        const stale = cmd(` --resume ${ID}`);
        assert.equal(await restartGoneResume(stale, dead), stale.replace("--resume", "--session-id"), stale);
      }
      if (agent === "codex") assert.equal(await withLiveCodexResume(cmd(` resume ${ID}`), home), cmd(), cmd());
    }
  }
});

// --- only a UUID is a session id: `--resume <word>` is a title or a search term ---

test("a --resume value that is not a UUID is a title: no rewrite, for claude and grok", async () => {
  const home = scratch();
  const config = scratch();
  const values = [`x${GONE}`, `${GONE}x`, `${GONE}-1`, "release-note", "name", "123", "'quoted name'", '"also quoted"', `'${GONE}'`, `"${GONE}"`, "abc-def-ghi"];
  for (const agent of ["claude", "grok"]) {
    for (const value of values) {
      for (const command of [`${agent} --resume ${value}`, `${agent} --resume=${value}`, `${agent} --model m --resume ${value} --x`]) {
        assert.equal(await restartGoneResume(command, dead), command, command);
        const live = agent === "claude" ? withLiveClaudeResume(command, config, A) : withLiveGrokResume(command, home, A);
        assert.equal(await live, command, command);
      }
    }
  }
});

test("a UUID --resume is rewritten in either spelling, upper case included", async () => {
  const upper = "ABCDEF01-2345-4678-89AB-CDEF01234567";
  assert.equal(await restartGoneResume(`claude --resume ${upper}`, dead), `claude --session-id ${upper}`);
  assert.equal(await restartGoneResume(`grok --resume=${GONE} --x`, dead), `grok --session-id ${GONE} --x`);
});

// --- flags are words of the command, not text that looks like one ---

test("a flag value that looks like --resume=<uuid> is a value: never rewritten, never dropped", async () => {
  for (const command of [
    `claude --append-system-prompt '--resume=${GONE}' --model m`,
    `claude --append-system-prompt "--resume=${GONE}"`,
    `grok --rules '--resume=${GONE}'`,
    `claude --append-system-prompt '--resume' '${GONE}'`,
    `claude '--resume' ${GONE}`,
    `claude "--resume=${GONE}"`,
  ]) {
    assert.equal(await restartGoneResume(command, dead), command, command);
  }
});

test("a quoted --continue is still a continue flag: a stale --resume beside it is left alone", async () => {
  for (const command of [`claude '--continue' --resume ${GONE}`, `claude "-c" --resume ${GONE}`, `claude --continue --resume ${GONE}`]) {
    assert.equal(await restartGoneResume(command, dead), command, command);
  }
  assert.equal(withOwnSessionId("claude '--continue'").sessionId, null);
});

// --- a path to the binary is the binary, for the per-pane opencode session too ---

test("ownSessionCommand: every spelling of the opencode program gets the pane's own session", async () => {
  const list = async () => [{ id: "ses_A", directory: A, updated: 1 }];
  for (const program of ["/opt/homebrew/bin/opencode", "./opencode", "~/bin/opencode", "exec opencode", "X=1 exec /usr/local/bin/opencode", "FOO='a b' /opt/opencode"]) {
    assert.equal(await ownSessionCommand(`${program} --continue`, A, list), `${program} --session ses_A`, program);
  }
});

test("ownSessionCommand: another agent's path, however spelled, is never asked about", async () => {
  const list = async () => assert.fail("listed");
  for (const program of ["/opt/bin/claude", "./codex", "~/bin/grok", "exec /x/claude", "/opt/bin/opencodex", "/opt/bin/myopencode", "env /opt/bin/opencode"]) {
    const command = `${program} --continue`;
    assert.equal(await ownSessionCommand(command, A, list), command, program);
  }
});


test("the log clock slack is one second: tests that build on LOG_CLOCK_SLACK_S hold it here", () => {
  assert.equal(LOG_CLOCK_SLACK_S, 1);
});
