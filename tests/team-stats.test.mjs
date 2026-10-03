// `aya team stats <team>`: what Aya did for a team, counted from its files. Table: team state (empty, no debug log,
// held and redelivered, rounds skipped, inbox owed, paused) x the row it shows; then the real CLI on a temp AYA_HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isolateHome } from "./helpers/isolate-home.mjs";
import { envWithoutAya } from "./helpers/env.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-team-stats-"));
isolateHome(root);
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const { teamStats, formatStats, holdKind, readTeamFiles } = await import("../dist-electron/team-stats.js");
const { TEAM_FILES, DEBUG_LOG_FILE, DEBUG_LOG_OLD_FILE, deliveryState } = await import("../dist-electron/team-records.js");

// Stats count wall-clock minutes (MINUTE_MS): the literal pins it, and the runs below span minutes of it.
const MINUTE_MS = 60_000;
const START = Date.parse("2026-10-03T10:00:00.000Z");
const NOW = START + 60 * MINUTE_MS;
const SAVED = `# crew

## Role: lead
Sends to: implementer, tester
Must not: skip a round

## Role: implementer
Sends to: lead, tester
Must not: skip a round

## Role: tester
Sends to: lead, implementer
Must not: skip a round

## Lead
lead

## Cadence
lead every 10 min
`;
const at = (min) => new Date(START + min * MINUTE_MS).toISOString();
const msg = (id, from, to, extra = {}) => ({ id, time: at(id), from, to, commit: "c1", text: "x", delivered: true, ...extra });
const ev = (min, event, fields = {}) => ({ time: at(min), event, ...fields });
const jsonl = (xs) => xs.map((x) => `${JSON.stringify(x)}\n`).join("");
const NONE = { saved: null, state: null, log: null, read: null, typing: null, notes: null, progress: null, assignments: null, debug: null };
const files = ({ log, debug, state, read, notes, progress, typing, saved = SAVED } = {}) => ({
  ...NONE,
  saved,
  log: log ? jsonl(log) : null,
  debug: debug ? jsonl(debug) : null,
  state: state ? JSON.stringify(state) : null,
  read: read ? JSON.stringify(read) : null,
  notes: notes ? JSON.stringify(notes) : null,
  progress: progress ? JSON.stringify(progress) : null,
  typing: typing ? JSON.stringify(typing) : null,
});

const TABLE = [
  [
    "empty team: nothing counted, no zeros where the debug log is missing",
    { ...NONE },
    (s, text) => {
      assert.equal(s.status.state, "not started");
      assert.equal(s.runTime, null);
      assert.equal(s.messages.total, 0);
      assert.deepEqual(s.inbox, []);
      assert.deepEqual(s.waits, []);
      assert.deepEqual(s.readMarks, []);
      assert.deepEqual(s.needsDebug, ["rounds typed and skipped", "hold decisions", "redeliveries", "pauses"]);
      assert.match(text, /run time \(log\.jsonl\)\s+no messages yet/);
      assert.match(text, /typed, skipped and why\s+needs aya debug on/);
      assert.doesNotMatch(text, /tried, not typed/);
    },
  ],
  [
    "no debug log: the file rows are counted, the debug rows say they need aya debug on",
    files({ log: [msg(1, "lead", "implementer"), msg(2, "implementer", "lead")], state: { started: true, lastRound: 7 }, notes: { lead: { 2: { kind: "held", reason: "shows an approval prompt" } } }, read: { lead: 2, implementer: 1 } }),
    (s, text) => {
      assert.equal(s.messages.total, 2);
      assert.equal(s.rounds.last, 7);
      assert.equal(s.rounds.typed, null);
      assert.equal(s.holdEvents, null);
      assert.equal(s.redeliveries, null);
      assert.equal(s.pauses, null);
      assert.deepEqual(s.heldMessages, [{ key: "held: shows an approval prompt", count: 1 }]);
      assert.equal(text.match(/needs aya debug on/g).length, 5, text);
      assert.match(text, /last round \(state\.json\)\s+7/);
    },
  ],
  [
    "messages per sender -> receiver, total, and the role most went to (Aya's and the user's are not load)",
    files({ log: [msg(1, "user", "lead"), msg(2, "lead", "implementer"), msg(3, "lead", "implementer"), msg(4, "tester", "implementer"), msg(5, "implementer", "lead"), msg(6, "aya", "lead")] }),
    (s, text) => {
      assert.deepEqual(s.messages.pairs, [
        { from: "lead", to: "implementer", count: 2 },
        { from: "aya", to: "lead", count: 1 },
        { from: "implementer", to: "lead", count: 1 },
        { from: "tester", to: "implementer", count: 1 },
        { from: "user", to: "lead", count: 1 },
      ]);
      assert.equal(s.messages.total, 6);
      assert.deepEqual(s.load.top, { role: "implementer", got: 3 });
      assert.deepEqual(s.load.roles, [
        { role: "lead", got: 1, sent: 2 },
        { role: "implementer", got: 3, sent: 1 },
        { role: "tester", got: 0, sent: 1 },
      ]);
      assert.match(text, /^ +2 {2}lead -> implementer$/m);
      assert.match(text, /^ +6 {2}total$/m);
      assert.equal(s.runTime.minutes, 5);
      assert.deepEqual([s.runTime.firstId, s.runTime.lastId], [1, 6]);
    },
  ],
  [
    "held and redelivered: hold kinds merged across message ids, redelivery tries by what the pane showed",
    files({
      log: [msg(1, "lead", "tester", { delivered: false }), msg(2, "lead", "tester", { delivered: false })],
      read: { tester: 2 },
      notes: { tester: { 1: { kind: "held", reason: "has text the user is typing" }, 2: { kind: "held", reason: "earlier message #1 for it is still waiting; this one follows it" } } },
      debug: [
        ev(1, "hold", { to: "tester", id: 1, reason: "has text the user is typing; it may be message #9 from lead, typed there with its Enter withheld: submit or clear it", typed: false }),
        ev(2, "hold", { to: "tester", id: 2, reason: "earlier message #1 for it is still waiting; this one follows it", typed: false }),
        ev(3, "hold", { to: "tester", id: 3, reason: "earlier message #2 for it is still waiting; this one follows it", typed: false }),
        ev(4, "redelivery", { role: "tester", id: 1, hold: "has text the user is typing" }),
        ev(5, "redelivery", { role: "tester", id: 1, hold: "has text the user is typing" }),
        ev(6, "redelivery", { role: "tester", id: 1, hold: null }),
      ],
    }),
    (s, text) => {
      assert.deepEqual(s.holdEvents, [
        { key: "earlier message #N for it is still waiting; this one follows it", count: 2 },
        { key: "has text the user is typing", count: 1 },
      ]);
      assert.deepEqual(s.redeliveries, { total: 3, byHold: [{ key: "has text the user is typing", count: 2 }, { key: "free: typed (or tried)", count: 1 }] });
      assert.deepEqual(s.heldMessages, [
        { key: "held: earlier message #N for it is still waiting; this one follows it", count: 1 },
        { key: "held: has text the user is typing", count: 1 },
      ]);
      assert.deepEqual(s.inbox, [], "the read mark passed both: they reached the pane");
      assert.match(text, /^ +3 {2}total$/m);
    },
  ],
  [
    "rounds: typed per reason, skipped per reason (clock times merged), the brake, talk that came in",
    files({
      state: { started: true, lastRound: 3 },
      debug: [
        ev(1, "round", { round: 1, reason: "rhythm", typed: true }),
        ev(2, "round", { round: 2, reason: "rhythm", typed: false }),
        ev(2, "round", { round: 2, skipped: "is busy working" }),
        ev(3, "round", { round: 2, skipped: "is busy working" }),
        ev(4, "round", { round: 2, skipped: "stalled: no change to the repo since 10:05" }),
        ev(5, "round", { round: 2, skipped: "stalled: no change to the repo since 10:15" }),
        ev(6, "round", { round: 2, skipped: "lead asked the user: which db?" }),
        ev(7, "round", { round: 2, reason: "silence", typed: true }),
        ev(8, "round", { round: 3, reason: "silence", typed: true, skipped: "talk came in while it waited for the lead's pane" }),
        ev(9, "round", { round: 4, held: "brake", unanswered: 3 }),
      ],
    }),
    (s, text) => {
      assert.deepEqual(s.rounds.typed, [{ key: "rhythm", count: 1 }, { key: "silence", count: 1 }]);
      assert.equal(s.rounds.notTyped, 1);
      assert.deepEqual(s.rounds.skipped, [
        { key: "is busy working", count: 2 },
        { key: "stalled: no change to the repo since HH:MM", count: 2 },
        { key: "lead asked the user", count: 1 },
        { key: "talk came in while it waited for the lead's pane", count: 1 },
      ]);
      assert.equal(s.rounds.heldUnanswered, 1);
      assert.match(text, /typed \(debug\.jsonl\)\s+rhythm 1, silence 1/);
      assert.match(text, /^ +2 {2}skipped: is busy working$/m);
      assert.match(text, /^ +1 {2}held: the lead did not answer the earlier rounds$/m);
    },
  ],
  [
    "inbox: owed messages per role past its read mark; Aya's own go stale, a typed one is not owed",
    files({
      log: [msg(1, "lead", "tester", { delivered: false }), msg(2, "aya", "tester", { delivered: false }), msg(3, "implementer", "tester", { delivered: false }), msg(4, "lead", "implementer", { delivered: false }), msg(5, "lead", "implementer")],
      read: { tester: 1, implementer: 0 },
      typing: { implementer: { queued: 4 } },
    }),
    (s, text) => {
      assert.deepEqual(s.inbox, [
        { role: "implementer", count: 1, oldestId: 4, oldestTime: at(4) },
        { role: "tester", count: 1, oldestId: 3, oldestTime: at(3) },
      ]);
      assert.deepEqual(s.readMarks.find((r) => r.role === "tester"), { role: "tester", mark: 1, lastTo: 3, typing: null });
      assert.deepEqual(s.readMarks.find((r) => r.role === "implementer"), { role: "implementer", mark: 0, lastTo: 5, typing: 4 });
      assert.deepEqual(s.readMarks.find((r) => r.role === "lead"), { role: "lead", mark: 0, lastTo: null, typing: null });
      assert.match(text, /^ {2}tester +1 \(oldest #3, /m);
      assert.match(text, /implementer +#0 \(last to it #5; typing #4\)/);
    },
  ],
  [
    "paused team: by whom, and the pauses the debug log saw",
    files({ state: { started: true, paused: true, pausedBy: "lead" }, debug: [ev(1, "unpause", { by: "user" }), ev(2, "pause", { by: "lead" })] }),
    (s, text) => {
      assert.deepEqual(s.status, { state: "paused", pausedBy: "lead" });
      assert.deepEqual(s.pauses, { pause: 1, unpause: 1 });
      assert.match(text, /state \(state\.json\)\s+paused by lead/);
      assert.match(text, /pauses \/ resumes \(debug\.jsonl\)\s+1 \/ 1/);
    },
  ],
  [
    "paused before pausedBy was kept: the user's; running once started and not paused",
    files({ state: { paused: true } }),
    (s) => assert.deepEqual(s.status, { state: "paused", pausedBy: "user" }),
  ],
  ["started, not paused: running", files({ state: { started: true, paused: false } }), (s) => assert.deepEqual(s.status, { state: "running", pausedBy: null })],
  [
    "who waits on whom (pendingWaits), with minutes to now",
    files({ log: [msg(1, "tester", "implementer"), msg(2, "lead", "tester")] }),
    (s) => {
      assert.deepEqual(s.waits.map((w) => [w.waiter, w.on, w.minutes]), [["tester", "implementer", 59], ["lead", "tester", 58]]);
    },
  ],
  [
    "commits: HEAD and HEADs seen from progress.json, distinct HEADs on messages",
    files({ log: [msg(1, "lead", "tester"), msg(2, "lead", "tester", { commit: "c2" }), msg(3, "lead", "tester", { commit: null }), msg(4, "tester", "lead", { commit: "c2" }), msg(5, "tester", "lead", { commit: "" })], progress: { commit: "c2", knownCommits: ["c0", "c1", "c2"], repoChangedAt: at(2) } }),
    (s, text) => {
      assert.deepEqual(s.commits, { head: "c2", knownHeads: 3, inLog: 2, repoChangedAt: at(2) });
      assert.match(text, /HEADs seen \(progress\.json\)\s+3/);
    },
  ],
  [
    "torn lines and a saved copy that no longer parses: skipped, roles from read.json",
    { ...NONE, saved: "not a team", log: `${JSON.stringify(msg(1, "a", "b"))}\n{"id":2,"ti\n`, read: '{"a":1,"b":1}', debug: '{"event":"hold","reason":"x"}\nnot json\n' },
    (s) => {
      assert.equal(s.messages.total, 1);
      assert.deepEqual(s.readMarks.map((r) => r.role), ["a", "b"]);
      assert.deepEqual(s.holdEvents, [{ key: "x", count: 1 }]);
    },
  ],
  [
    "an hour-long run reads in hours; a wait dated after now (a clock ahead) is 0 min, never negative",
    files({ log: [msg(1, "lead", "tester"), msg(61, "tester", "implementer")] }),
    (s, text) => {
      assert.equal(s.runTime.minutes, 60);
      assert.match(text, /, 1 h 0 min \(messages #1\.\.#61\)/);
      assert.deepEqual(s.waits.map((w) => [w.waiter, w.on, w.minutes]), [["lead", "tester", 59], ["tester", "implementer", 0]]);
    },
  ],
  [
    "a reply the read mark passed reached its pane: its sender's question is answered, though the log says not delivered",
    files({ log: [msg(1, "lead", "tester"), msg(2, "tester", "lead", { delivered: false })], read: { lead: 2, tester: 1 } }),
    (s) => assert.deepEqual(s.waits.map((w) => [w.waiter, w.on]), [["tester", "lead"]]),
  ],
];

for (const [label, input, check] of TABLE) {
  test(`teamStats | ${label}`, () => {
    const stats = teamStats("crew", input, NOW);
    check(stats, formatStats(stats));
  });
}

test("holdKind: one kind per reason, whatever ids, times and draft owners it names", () => {
  assert.equal(holdKind("earlier message #12 for it is still waiting; this one follows it"), "earlier message #N for it is still waiting; this one follows it");
  assert.equal(holdKind("has text the user is typing; it may be message #3 from lead, typed there: submit or clear it"), "has text the user is typing");
  assert.equal(holdKind("shows an approval prompt"), "shows an approval prompt");
});

test("deliveryState: the read mark, Aya's own messages and the notes decide what the window shows", () => {
  const m = (from, extra = {}) => ({ id: 5, time: at(5), from, to: "tester", text: "x", delivered: false, ...extra });
  assert.equal(deliveryState(m("lead"), undefined, 5).delivered, true, "the read mark reached it: typed");
  assert.equal(deliveryState(m("lead"), undefined, 4).delivered, false, "before the read mark: still owed");
  assert.equal(deliveryState(m("aya"), undefined, 5).delivered, false, "Aya's own go stale, not typed");
  assert.deepEqual(deliveryState(m("lead"), { kind: "held", reason: "r" }, 5), { ...m("lead"), delivered: true, held: "r" });
  assert.deepEqual(deliveryState(m("lead"), { kind: "held", reason: "r" }, 4), { ...m("lead"), held: "r" });
  assert.deepEqual(deliveryState(m("lead"), { kind: "inbox" }, 0), { ...m("lead"), viaInbox: true, delivered: true });
  assert.deepEqual(deliveryState(m("aya"), { kind: "inbox" }, 0), { ...m("aya"), viaInbox: true }, "read with the inbox, still held (stale)");
  assert.deepEqual(deliveryState(m("lead"), { kind: "withheld", reason: "r" }, 0), { ...m("lead"), delivered: true, held: "r", typedOnly: true });
  assert.equal(deliveryState(m("lead"), { kind: "withheld", reason: "r", afterEnter: true }, 0).afterEnter, true);
});

test("readTeamFiles: the rotated debug log first, a torn last line kept apart, absent files null", () => {
  const dir = mkdtempSync(join(root, "files-"));
  writeFileSync(join(dir, DEBUG_LOG_OLD_FILE), '{"event":"pause"}');
  writeFileSync(join(dir, DEBUG_LOG_FILE), '{"event":"unpause"}\n');
  writeFileSync(join(dir, TEAM_FILES.refused), "r\n");
  const read = readTeamFiles(dir);
  assert.equal(read.debug, '{"event":"pause"}\n{"event":"unpause"}\n');
  assert.equal(read.refused, "r\n");
  assert.equal(read.log, null);
  assert.equal(readTeamFiles(mkdtempSync(join(root, "files-"))).debug, null);
});

test("the package unpacks every module team-stats.js loads: the CLI runs it with plain node, which cannot read app.asar", () => {
  const unpacked = new Set(JSON.parse(readFileSync("package.json", "utf8")).build.asarUnpack);
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const [, dep] of readFileSync(join("dist-electron", name), "utf8").matchAll(/require\("\.\/([^"]+)"\)/g)) walk(dep.endsWith(".js") ? dep : `${dep}.js`);
  };
  walk("team-stats.js");
  assert.ok(seen.size > 1);
  for (const name of seen) assert.ok(unpacked.has(`dist-electron/${name}`), `dist-electron/${name} is not in build.asarUnpack`);
});

const cli = resolve("bin/aya");
const CLI_TIMEOUT_MS = 10_000;
const ayaHome = (h) => join(h, "aya");

function teamHome(projects) {
  const h = mkdtempSync(join(root, "cli-"));
  for (const [project, team, write] of projects) {
    const dir = join(ayaHome(h), "teams", project, team);
    mkdirSync(dir, { recursive: true });
    write(dir);
  }
  return h;
}
const runCli = (h, args, extra = {}) =>
  spawnSync("/bin/sh", [cli, ...args], { env: { ...envWithoutAya(), HOME: h, AYA_HOME: ayaHome(h), ...extra }, encoding: "utf8", timeout: CLI_TIMEOUT_MS });

test("aya team stats <team> [--json]: the real CLI on a temp AYA_HOME, read-only, Aya not running", () => {
  const fixture = (dir) => {
    writeFileSync(join(dir, TEAM_FILES.saved), SAVED);
    writeFileSync(join(dir, TEAM_FILES.state), JSON.stringify({ started: true, paused: true, pausedBy: "user", lastRound: 4 }));
    writeFileSync(join(dir, TEAM_FILES.log), jsonl([msg(1, "lead", "tester"), msg(2, "tester", "lead", { delivered: false })]));
    writeFileSync(join(dir, TEAM_FILES.read), JSON.stringify({ tester: 1 }));
    writeFileSync(join(dir, DEBUG_LOG_FILE), jsonl([ev(1, "hold", { to: "lead", id: 2, reason: "shows a numbered choice", typed: false })]));
  };
  const h = teamHome([["game", "crew", fixture]]);
  const logFile = join(ayaHome(h), "teams", "game", "crew", TEAM_FILES.log);
  const before = readFileSync(logFile, "utf8");
  let r = runCli(h, ["team", "stats", "crew"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^team crew$/m);
  assert.match(r.stdout, /state \(state\.json\)\s+paused by user/);
  assert.match(r.stdout, /^ +1 {2}tester -> lead$/m);
  assert.match(r.stdout, /^ +1 {2}shows a numbered choice$/m);
  assert.match(r.stdout, /^ {2}lead +1 \(oldest #2, /m);
  assert.match(r.stdout, /last round \(state\.json\)\s+4/);
  r = runCli(h, ["team", "stats", "crew", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.messages.total, 2);
  assert.deepEqual(json.inbox.map((i) => [i.role, i.count]), [["lead", 1]]);
  assert.deepEqual(json.needsDebug, []);
  // --now: the lead's round digest from the same files; message #2 waits on the lead.
  r = runCli(h, ["team", "stats", "crew", "--now"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Since \d\d:\d\d \(no round before\): \+2 messages, no commits\nWaiting on you: tester #2 for \d+ (h \d+ )?min\n/);
  assert.equal(readFileSync(logFile, "utf8"), before, "nothing written");
});

test("aya team stats: no such team, a team in two projects, a bad flag", () => {
  const saved = (dir) => writeFileSync(join(dir, TEAM_FILES.saved), SAVED);
  // A directory with no saved copy (a removed team's late debug line) is not a project of the team.
  const unsaved = (dir) => writeFileSync(join(dir, DEBUG_LOG_FILE), "");
  const h = teamHome([["game", "crew", saved], ["old", "crew", unsaved], ["site", "crew", saved]]);
  let r = runCli(h, ["team", "stats", "nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no team nope/);
  r = runCli(h, ["team", "stats", "crew"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /more than one project \(game, site\); set AYA_PROJECT_SLUG/);
  assert.doesNotMatch(r.stderr, /no team/, "one reason, not two");
  r = runCli(h, ["team", "stats", "crew"], { AYA_PROJECT_SLUG: "site" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no messages yet/);
  r = runCli(h, ["team", "stats", "crew", "--bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
  // team debug shares the lookup (team_dir): no such team is an error even when following.
  r = runCli(h, ["team", "debug", "nope", "-f"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no debug log for team nope/);
});
