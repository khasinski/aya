// Progress is a change to the repo (a new HEAD or a changed working tree), not talk.
// One cadence "minute" lasts 2 s here, so T_stall (60 min) is 120 s and the quiet limit (30 min) 60 s: under 3 minutes.

process.env.AYA_E2E_TEAM_MINUTE_MS = "2000";
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-repo-progress-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamLiveness, observe, parseProgress } = await import("../dist-electron/team-progress.js");
const { STALL_AFTER_MS, SILENCE_FIRST_MS, BLOCKED_AFTER_MS } = await import("../dist-electron/team-times.js");
const { HOLD_APPROVAL } = await import("../dist-electron/pane-holds.js");
const { recordAgentStatus } = await import("../dist-electron/agent-status.js");
const git = await import("../dist-electron/git.js");
const { livenessLine } = await import("../dist-test/team-view.js");

const S = 1000;
const T = STALL_AFTER_MS / S;
const ROLES = ["tester", "implementer"];
const TEAM = ({ cadence = false } = {}) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
tester
${cadence ? "\n## Cadence\ntester every 1 min\n" : ""}`;

test("the times here: T_stall 120 s, the quiet limit 60 s", () => {
  assert.deepEqual([STALL_AFTER_MS, SILENCE_FIRST_MS], [120 * S, 60 * S]);
});

async function world(opts = {}) {
  for (const pane of ["pane-t", "pane-i"]) recordAgentStatus(pane, "clear", 0);
  const { teamHome, project, cleanup } = teamProject("aya-repo-progress-", { teamFile: TEAM(opts), tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { commit: "c0", tree: "t0", busy: new Set(), typed: [], jobs: [], now: Date.parse("2026-10-01T20:52:14Z"), edits: 0, commits: 0, holds: {} };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text, at: w.now }),
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => w.commit,
    treeState: async () => w.tree,
    busy: async (pane) => w.busy.has(pane),
  };
  const track = (list) => (fn, ms, firstMs = ms) => {
    const job = { fn, ms, firstMs };
    list.push(job);
    return () => {};
  };
  const make = () => {
    w.jobs.length = 0;
    w.runner = new TeamRunner(w.deps, track(w.jobs), () => w.now, () => {});
  };
  make();
  const toLead = () => w.typed.filter((t) => t.pane === "pane-t" && /\| from aya \|/.test(t.text) && !/Delivery test/.test(t.text));
  const message = (text = "1b27df1 stays at 489 nodes, measure it again") =>
    store.append({ from: "implementer", to: "tester", commit: w.commit, text, delivered: true, time: new Date(w.now).toISOString() });
  const ACTIONS = {
    start: () => w.runner.start("game", "ux-review"),
    pause: () => w.runner.pause("game", "ux-review"),
    resume: () => w.runner.resume("game", "ux-review"),
    restart: async () => (make(), w.runner.restore()),
    check: () => w.jobs.at(-1)?.fn(),
    tick: () => w.jobs.at(-1)?.fn(),
    message: () => message(),
    ack: () => message("ok"),
    commit: () => void (w.commit = `c${++w.commits}`),
    edit: () => void (w.tree = `t${++w.edits}`),
    "lead busy": () => void w.busy.add("pane-t"),
    "lead free": () => void w.busy.delete("pane-t"),
    "lead waits for user": () => recordAgentStatus("pane-t", "waiting", w.now),
    "tester approval": () => void (w.holds["pane-t"] = HOLD_APPROVAL),
    "screen answered": () => void delete w.holds["pane-t"],
  };
  const run = async (...steps) => {
    for (const step of steps) {
      if (typeof step === "number") w.now += step * S;
      else await ACTIONS[step]();
    }
  };
  const live = () => teamLiveness(store, ROLES, w.deps.holdReason, { cadence: !!opts.cadence, lead: true }, w.now);
  return { w, store, toLead, run, live, cleanup: () => (w.runner.stopAll(), cleanup()) };
}

const progressTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const t = await world(...args);
    try {
      await fn(t);
    } finally {
      t.cleanup();
    }
  });
};

const talk = (seconds, every = 10) => Array.from({ length: Math.floor(seconds / every) }, () => [every, "message"]).flat();
const talkChecked = (seconds) => talk(seconds).flatMap((s) => (s === "message" ? ["message", "check"] : [s]));

// [name, steps (numbers are seconds), status, what the stall runs on]
const CASES = [
  ["nothing, just under T_stall: progressing", ["start", T - 1, "check"], "progressing", null],
  ["nothing, past T_stall: stalled on the repo", ["start", T + 1, "check"], "stalled", "repo"],
  ["only messages, just under T_stall: talking", ["start", ...talk(T - 10), 9, "check"], "talking", null],
  ["only messages, past T_stall: stalled though the roles keep talking", ["start", ...talk(T), 1, "check"], "stalled", "repo"],
  ["only acks: not talking, and stalled past T_stall", ["start", 10, "ack", T - 9, "check"], "stalled", "repo"],
  ["a commit at 60 s, then messages, just under T_stall after it: talking", ["start", 60, "commit", "check", ...talk(T - 10), 9, "check"], "talking", null],
  ["a commit at 60 s, then messages, past T_stall after it: stalled", ["start", 60, "commit", "check", ...talk(T), 1, "check"], "stalled", "repo"],
  ["a commit, nothing after, just under T_stall after it: progressing", ["start", 60, "commit", "check", T - 1, "check"], "progressing", null],
  ["an edit (no commit) at 60 s, just under T_stall after it: not stalled", ["start", "check", 60, "edit", "check", T - 1, "check"], "progressing", null],
  ["an edit at 60 s, past T_stall after it: stalled", ["start", "check", 60, "edit", "check", T + 1, "check"], "stalled", "repo"],
  ["the same tree read again is no change", ["start", "check", 60, "check", 61, "check"], "stalled", "repo"],
  ["a stall ends at the next tick after an edit", ["start", T + 1, "check", 5, "edit", "check"], "progressing", null],
  ["a stall ends at the next look after a commit", ["start", T + 1, "check", 5, "commit", "check"], "progressing", null],
  ["messages after a stall do not end it", ["start", T + 1, "check", ...talk(30)], "stalled", "repo"],
  ["a restart while talking: the repo clock counts from the launch", ["start", ...talk(100), "restart", ...talk(30), "check"], "talking", null],
  ["... and stalls T_stall after the launch", ["start", ...talk(100), "restart", ...talk(T), 1, "check"], "stalled", "repo"],
  ["a restart after a repo stall keeps the stall", ["start", T + 1, "check", "restart", 30, "check"], "stalled", "repo"],
  ["... and a change after it ends the stall", ["start", T + 1, "check", "restart", 30, "commit", "check"], "progressing", null],
  ["Resume starts the repo clock over", ["start", 100, "pause", 1000, "resume", 100, "check"], "progressing", null],
  ["paused: no status of the repo", ["start", T + 1, "pause"], "paused", null],
];

for (const [name, steps, status, on] of CASES) {
  progressTest(`repo progress | ${name}`, async (t) => {
    await t.run(...steps);
    const live = await t.live();
    assert.equal(live.status, status, "status");
    assert.equal(live.stalledSince !== null, on === "repo", "stalled on the repo");
  });
}

// The count is of talk since the window's "since": every event that restarts the stall clock restarts it too.
const B = Math.ceil(BLOCKED_AFTER_MS / S);
const CLOCK_EVENTS = [
  ["a commit", ["commit", "check"]],
  ["an edit", ["edit", "check"]],
  ["Start after a pause", ["pause", "start", "check"]],
  ["Resume", ["pause", "resume", "check"]],
  ["an answered screen (a wake)", ["tester approval", "check", B, "check", "screen answered", "check", "check"]],
  ["a relaunch", ["restart", "check"]],
];

for (const [event, steps] of CLOCK_EVENTS) {
  progressTest(`repo progress | ${event} restarts the stall clock and the messages counted since it`, async (t) => {
    await t.run("start", "check", ...talkChecked(30), 5);
    assert.equal((await t.live()).repo.messages, 3, "talk before the event is counted");
    const at = t.w.now;
    await t.run(...steps);
    const live = await t.live();
    assert.ok(Date.parse(live.repo.since) >= at, `the clock restarted at the ${event}`);
    assert.deepEqual([live.status, live.repo.messages], ["progressing", 0], "no talk since the clock restarted");
  });
}

progressTest("repo progress | a relaunch of a team stalled at the last look keeps its stall and its messages", async (t) => {
  await t.run("start", "check", ...talkChecked(30), T, "check", "restart", "check");
  const live = await t.live();
  assert.deepEqual([live.status, live.repo.messages], ["stalled", 3]);
});

progressTest("the stall round: one, to the lead, naming the last change to the repo and the messages since", async (t) => {
  await t.run("start", "check", ...talkChecked(T - 10), 11, "check");
  const rounds = t.toLead();
  assert.equal(rounds.length, 1, "one round, at the stall; no quiet round while they talk");
  assert.match(rounds[0].text, new RegExp(`Round 1: stalled: no change to the repo since ${hhmm("2026-10-01T20:52:14Z")} \\(11 messages\\)\\.`));
  assert.match(rounds[0].text, /aya status waiting/);
  await t.run(20, "check", 20, "check", ...talk(20), "check");
  assert.equal(t.toLead().length, 1, "once per stall, however long it lasts or they talk");
  const live = await t.live();
  assert.equal(live.repo.messages, 13);
  assert.equal(livenessLine(live).text, `stalled: no change to the repo since ${hhmm(live.repo.since)} (13 messages) - rounds are paused until the repo changes`);
  // A change ends it; another T_stall of talk is a new stall, and a new round.
  await t.run(5, "edit", "check");
  assert.equal((await t.live()).status, "progressing");
  await t.run(...talkChecked(T), 1, "check");
  assert.deepEqual(
    t.toLead().map((r) => r.text.match(/Round (\d+): (\w+)/).slice(1).join(" ")),
    ["1 stalled", "2 stalled"],
  );
});

progressTest("the stall round with a cadence: carried by the tick, not typed twice", { cadence: true }, async (t) => {
  await t.run("start", ...talk(T), 1, "tick", "check", 2, "check", 60, "tick");
  const stalled = t.toLead().filter((r) => /stalled: no change to the repo/.test(r.text));
  assert.equal(stalled.length, 1);
});

test("the stall round waits for a busy lead and goes out once it is free; a lead that asked the user gets none", async () => {
  const t = await world();
  try {
    await t.run("start", "lead busy", T + 1, "check");
    assert.equal(t.toLead().length, 0, "busy: held");
    await t.run("lead free", 2, "check");
    assert.equal(t.toLead().filter((r) => /stalled/.test(r.text)).length, 1);
  } finally {
    t.cleanup();
  }
  const asked = await world();
  try {
    await asked.run("start", 10, "lead waits for user", T, "check", 30, "check");
    assert.equal(asked.toLead().length, 0);
    assert.equal((await asked.live()).status, "stalled");
  } finally {
    asked.cleanup();
  }
});

progressTest("the window: talking and the repo stall in words", async (t) => {
  await t.run("start", ...talk(30), 5, "check");
  const live = await t.live();
  assert.equal(live.status, "talking");
  assert.deepEqual(livenessLine(live), {
    text: `talking - no change to the repo since ${hhmm(live.repo.since)} (3 messages); flagged after 60 min without one`,
    tone: "ok",
  });
});

// An older progress.json has no repo fields: the stall clock then starts from its last progress.
progressTest("migration: a progress.json from older code is read, and no false stall comes of it", async (t) => {
  await t.run("start");
  const legacy = { seenMessageId: 0, commit: "c0", idleRounds: 0, awaiting: false, changedAt: new Date(t.w.now - 30 * S).toISOString(), stalledLogged: false, blocked: {} };
  writeFileSync(join(t.store.dir, "progress.json"), JSON.stringify(legacy));
  assert.notEqual(parseProgress(legacy), null);
  assert.equal((await t.live()).status, "progressing");
  await t.run("check", T - 31, "check");
  assert.equal((await t.live()).status, "progressing", "the first tree read is a baseline, not a change, and the clock runs from the old progress");
  await t.run(2, "check");
  assert.equal((await t.live()).status, "stalled", "T_stall after the old progress, not before");
  // A relaunch starts the clock over.
  writeFileSync(join(t.store.dir, "progress.json"), JSON.stringify({ ...legacy, changedAt: new Date(t.w.now - 1000 * S).toISOString() }));
  await t.run("restart", 10, "check");
  assert.equal((await t.live()).status, "progressing");
});

// A live log: HEAD stayed 1b27df1 from #168 (20:52:14Z) to the Pause. Replayed with its times scaled to the 2 s minute.
const SUDOKU = [
  [168, "20:52:14", "implementer", "benchmarker", "Committed 1b27df1 naked pairs; please measure"],
  [180, "20:53:02", "benchmarker", "leader", "1b27df1: easy 51, medium 45, hard 393, total 489"],
  [190, "20:54:10", "leader", "implementer", "Next cut: hidden singles before branching"],
  [200, "20:55:01", "implementer", "leader", "Did not check out 331ef96 and it is not HEAD"],
  [210, "20:55:59", "benchmarker", "implementer", "Blob e2c017cc27e9f0afa7b6782294f45256c984f813, commit 1b27df1"],
  [220, "20:56:40", "leader", "benchmarker", "627 is history for 18abd16. The standing total is 1b27df1"],
  [230, "20:57:30", "implementer", "benchmarker", "331ef96 total 805 is not the round. Do not check it out"],
  [240, "20:58:20", "benchmarker", "leader", "Standing total is 1b27df1: easy 51, medium 45, hard 393, total 489"],
  [250, "20:59:28", "benchmarker", "leader", "Standing total is 1b27df1: easy 51, medium 45, hard 393, total 489. 18abd16 was 627"],
  [256, "20:59:52", "leader", "benchmarker", "Do not cat-file e2c017cc again. 1b27df1 is already easy 51, medium 45"],
];

test("replay of the sudoku log: a loop of messages with no commit is stalled T_stall after the last commit", async () => {
  const { teamHome, project, cleanup } = teamProject("aya-repo-replay-", { teamFile: TEAM(), tabs: [{ id: "pane-t" }] });
  try {
    const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
    await store.setPaused(false);
    const at = (hms) => Date.parse(`2026-10-01T${hms}.000Z`);
    await store.updateProgress(() => ({ seenMessageId: 167, commit: "1b27df1", tree: "w", idleRounds: 0, awaiting: false, changedAt: "2026-10-01T20:52:14.000Z", repoChangedAt: "2026-10-01T20:52:14.000Z", messages: 0, stalledLogged: false, blocked: {} }));
    const statuses = [];
    const scale = (ms) => at("20:52:14") + ((ms - at("20:52:14")) * 2) / 60;
    for (const [id, hms, from, to, text] of SUDOKU) {
      appendFileSync(join(store.dir, "log.jsonl"), `${JSON.stringify({ id, time: new Date(scale(at(hms))).toISOString(), from, to, commit: "1b27df1", text, delivered: true })}\n`);
      await observe(store, "1b27df1", {}, new Date(scale(at(hms))).toISOString(), "w");
      statuses.push((await teamLiveness(store, ROLES, async () => null, { cadence: true, lead: true }, scale(at(hms)))).status);
    }
    assert.ok(statuses.every((s) => s === "talking"), `talking while they loop, not progressing: ${statuses}`);
    const later = at("20:52:14") + STALL_AFTER_MS + S;
    appendFileSync(join(store.dir, "log.jsonl"), `${JSON.stringify({ id: 257, time: new Date(later - S).toISOString(), from: "implementer", to: "leader", commit: "1b27df1", text: "No reset. 331ef96 is not HEAD", delivered: true })}\n`);
    await observe(store, "1b27df1", {}, new Date(later).toISOString(), "w");
    const live = await teamLiveness(store, ROLES, async () => null, { cadence: true, lead: true }, later);
    assert.equal(live.status, "stalled");
    assert.notEqual(live.stalledSince, null);
    assert.equal(live.repo.messages, SUDOKU.length + 1);
    assert.match(livenessLine(live).text, /^stalled: no change to the repo since \d\d:\d\d \(11 messages\)/);
  } finally {
    cleanup();
  }
});

function hhmm(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

test("workingTreeState: changes with every edit, also of a file already changed; the same tree reads the same", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-tree-state-"));
  const sh = (...args) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    assert.equal(await git.workingTreeState(dir), null, "not a repo: unknown");
    sh("init", "-q");
    assert.equal(await git.workingTreeState(dir), null, "no commit yet: unknown");
    writeFileSync(join(dir, "solver.js"), "a\n");
    sh("add", ".");
    sh("commit", "-qm", "one");
    const clean = await git.workingTreeState(dir);
    assert.equal(typeof clean, "string");
    assert.equal(await git.workingTreeState(dir), clean, "nothing changed: the same");
    writeFileSync(join(dir, "solver.js"), "b\n");
    const first = await git.workingTreeState(dir);
    assert.notEqual(first, clean, "a tracked file edited");
    writeFileSync(join(dir, "solver.js"), "c\n");
    const second = await git.workingTreeState(dir);
    assert.notEqual(second, first, "the same file edited again: its status line is the same, its diff is not");
    writeFileSync(join(dir, "notes.txt"), "x\n");
    assert.notEqual(await git.workingTreeState(dir), second, "a new untracked file");
    assert.equal(readFileSync(join(dir, "solver.js"), "utf8"), "c\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
