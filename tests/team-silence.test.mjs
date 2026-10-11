// One cadence "minute" lasts 3 s here (AYA_E2E_TEAM_MINUTE_MS), so the 30 / 10 / 60 min defaults
// are 90 / 30 / 180 s: no rhythm or silence limit in this file exceeds 3 minutes.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
// recordAgentStatus keeps a lead's question on disk under AYA_HOME.
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-silence-home-"));

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";
import { literal } from "./helpers/regex.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { teamLiveness } = await import("../dist-electron/team-progress.js");
const times = await import("../dist-electron/team-times.js");
const { WALL_MINUTE_MS } = times;
const { DIGEST_IDLE_MIN, digestOneLine } = await import("../dist-electron/team-digest.js");
const { digestFromFiles, readTeamFiles } = await import("../dist-electron/team-stats.js");
const { recordAgentStatus } = await import("../dist-electron/agent-status.js");
const { HOLD_DRAFT, HOLD_NOT_RUNNING } = await import("../dist-electron/pane-holds.js");

const MIN = TEST_TEAM_MINUTE_MS;
const S = 1000;
const L = 30 * MIN;
const M = 10 * MIN;
const T = 60 * MIN;
const ROLES = ["tester", "implementer"];

const TEAM = ({ lead = true, cadence = false, status = null } = {}) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report
${lead ? "\n## Lead\ntester\n" : ""}${cadence ? "\n## Cadence\ntester every 30 min\n" : ""}${status ? `\n## Status command\n${status}\n` : ""}`;

test("the defaults live in one place: 30 min first, 10 min after, stalled at 60, all under 3 minutes here", () => {
  assert.deepEqual([times.SILENCE_FIRST_MIN, times.SILENCE_REPEAT_MIN, times.STALL_AFTER_MIN], [30, 10, 60]);
  assert.deepEqual([times.SILENCE_FIRST_MS, times.SILENCE_REPEAT_MS, times.STALL_AFTER_MS], [L, M, T]);
  assert.ok(times.STALL_AFTER_MS <= 3 * 60_000);
});

let nextWorld = 0;
const IMPLEMENTER_PANE = (t) => t.w.paneIds.lead.replace(/-t$/, "-i");

async function world(opts = {}) {
  const number = ++nextWorld;
  const paneT = `silence-${number}-t`;
  const paneI = `silence-${number}-i`;
  const paneT2 = `silence-${number}-t2`;
  // Status is process-wide: unique pane ids keep parallel worlds independent.
  for (const pane of [paneT, paneT2, paneI]) recordAgentStatus(pane, "clear", 0);
  const { teamHome, project, cleanup } = teamProject("aya-silence-", { teamFile: TEAM(opts), tabs: [{ id: paneT }, { id: paneI }, { id: paneT2 }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", paneT);
  await store.assign("implementer", paneI);
  const w = { holds: { [paneT]: null, [paneI]: null }, busy: new Set(), commit: "c0", typed: [], jobs: [], now: Date.parse("2026-09-30T10:00:00Z"), teamHome, paneIds: { lead: paneT, replacement: paneT2 } };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text, at: w.now }),
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => w.commit,
    busy: async (pane) => w.busy.has(pane),
  };
  const track = (list) => (fn, ms, firstMs = ms) => {
    const job = { fn, ms, firstMs, cancelled: false };
    list.push(job);
    return () => (job.cancelled = true);
  };
  const make = () => {
    w.jobs.length = 0;
    w.runner = new TeamRunner(w.deps, track(w.jobs), () => w.now, () => {});
  };
  make();
  const toLead = () => w.typed.filter((t) => t.pane === paneT && /\| from aya \|/.test(t.text) && !/Delivery test/.test(t.text));
  const rounds = () => toLead().flatMap((t) => t.text.match(/Aya round (\d+):/)?.[1] ?? []).map(Number);
  const send = (from, to, text) => handleTeamRequest({ type: "team-send", role: to, text }, from, w.deps).catch(() => {});
  const live = () => teamLiveness(store, ROLES, w.deps.holdReason, { cadence: opts.cadence ? 30 : null, lead: opts.lead !== false }, w.now, async () => w.commit);
  const ACTIONS = {
    start: () => w.runner.start("game", "ux-review"),
    pause: () => w.runner.pause("game", "ux-review"),
    resume: () => w.runner.resume("game", "ux-review"),
    restart: async () => (make(), w.runner.restore()),
    refresh: () => w.runner.refresh("game", "ux-review"),
    // The rhythm's beat, the silence check and the retry of an owed round are all a look of the one clock.
    check: () => w.jobs.at(-1)?.fn(),
    retry: () => w.jobs.at(-1)?.fn(),
    tick: () => w.jobs.at(-1)?.fn(),
    "implementer waits on tester": () =>
      store.append({ from: "implementer", to: "tester", commit: null, text: "report: the timer test fails on CI", delivered: true, time: new Date(w.now - 31 * MIN).toISOString() }),
    "lead answers": () => send(paneT, "implementer", "decision: ship the retry, I reran the timer test and it is green"),
    ack: () => send(paneT, "implementer", "ok"),
    // Written at the fake clock's time (a sent message carries the wall clock's).
    "lead reports": () =>
      store.append({ from: "tester", to: "implementer", commit: null, text: "decision: ship the retry, the timer test is green", delivered: true, time: new Date(w.now).toISOString() }),
    commit: () => void (w.commit = `c${Math.random()}`),
    "lead busy": () => void w.busy.add(paneT),
    "lead draft": () => void (w.holds[paneT] = HOLD_DRAFT),
    "lead gone": () => void (w.holds[paneT] = HOLD_NOT_RUNNING),
    "lead free": () => void ((w.holds[paneT] = null), w.busy.delete(paneT)),
    "lead waits for user": () => recordAgentStatus(paneT, "waiting", w.now),
    "lead status clear": () => recordAgentStatus(paneT, "clear", w.now),
    "implementer waits for user": () => recordAgentStatus(paneI, "waiting", w.now),
    "lead pane replaced": () => store.assign("tester", paneT2),
    "lead pane closed": () => store.releasePane(paneT),
    "after 8 h": () => void (w.now += 8 * 3600_000),
    "late answer": () =>
      store.append({ from: "tester", to: "implementer", commit: null, text: "decision: ship the retry, the timer test is green", delivered: true, time: new Date(Date.parse("2026-09-30T10:00:00Z") + 5 * S).toISOString() }),
  };
  const run = async (...steps) => {
    for (const step of steps) {
      if (typeof step === "number") w.now += step * S;
      else await ACTIONS[step]();
    }
  };
  return { w, store, rounds, toLead, live, run, send, cleanup };
}

const silenceTest = (name, ...args) => {
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

// [name, options, steps (numbers are seconds), rounds the lead got, status at the end]
// A message is talk, not progress: only a change to the repo restarts the stall clock (T, 180 s here).
describe("silence with independent teams", { concurrency: 16 }, () => {
  const CASES = [
    ["R6.1 quiet for just under the limit: nothing", {}, ["start", 89, "check"], [], "progressing"],
    ["R6.1 quiet past the limit: the lead gets Aya round 1", {}, ["implementer waits on tester", "start", 91, "check"], [1], "progressing"],
    ["R6.1 exactly at the limit: the round is due", {}, ["start", 90, "check"], [1], "progressing"],
    ["R6.1 the same with a rhythm: still one round, not a second", { cadence: true }, ["start", 91, "check"], [1], "progressing"],
    ["R6.2 progress just before the limit zeroes the clock", {}, ["start", 89, "lead answers", "check", 2, "check"], [], "talking"],
    ["R6.2 ... and the limit counts from that progress (T_stall after the start too: that round says stalled)", {}, ["start", 89, "lead answers", "check", 91, "check"], [1], "stalled"],
    ["R6.2 an ack is not progress", {}, ["start", 89, "ack", "check", 2, "check"], [1], "progressing"],
    ["R6.2 a commit is progress", {}, ["start", 89, "commit", "check", 2, "check"], [], "progressing"],
    ["after the first round the next comes M later, not L", {}, ["start", 91, "check", 29, "check"], [1], "progressing"],
    ["... and at M it does", {}, ["start", 91, "check", 31, "check"], [1, 2], "progressing"],
    ["rounds at L, L+M, L+2M, the one at T says stalled, then none", {}, ["start", 91, "check", 30, "check", 30, "check", 30, "check", 30, "check"], [1, 2, 3, 4], "stalled"],
    ["the lead answers, then the silence starts over and the numbers go on", {}, ["start", 91, "check", 5, "lead answers", "check", 85, "check", 6, "check"], [1, 2], "stalled"],
    ["R6.3 cadence tick and silence due at once: one round, whichever is first", { cadence: true }, ["start", 90, "tick", "check"], [1], "progressing"],
    ["R6.3 ... the other way round", { cadence: true }, ["start", 90, "check", "tick"], [1], "progressing"],
    ["R6.3 ... and the next one is M later on the shared count", { cadence: true }, ["start", 90, "tick", "check", 30, "check"], [1, 2], "progressing"],
    ["R6.3 a cadence round that carried the quiet text stands for the quiet round: none a check later", { cadence: true }, ["start", 90, "tick", 5, "check"], [1], "progressing"],
    ["R6.3 ... and the next is M after it", { cadence: true }, ["start", 90, "tick", 5, "check", 26, "check"], [1, 2], "progressing"],
    ["a reply found late counts from when it was written", {}, ["start", 60, "late answer", 20, "check", 20, "check"], [1], "talking"],
    // The lead's answer at 10 s moves the silence to 100 s, so the beat at 90 s is a plain round.
    ["R6.3 a plain cadence round a moment before the silence is due holds the silence round back", { cadence: true }, ["start", 10, "lead reports", 80, "tick", 10, "check"], [1], "talking"],
    ["R6.3 ... and the silence round comes M after the plain one, so it is only held, not lost", { cadence: true }, ["start", 10, "lead reports", 80, "tick", 10, "check", 20, "check"], [1, 2], "talking"],
    ["R6.4 a busy lead: the round waits, nobody is unreachable", {}, ["start", "lead busy", 91, "check"], [], "progressing"],
    ["R6.4 ... and goes out once the lead is free", {}, ["start", "lead busy", 91, "check", "lead free", 31, "check"], [1], "progressing"],
    ["R6.8 a lead that answers leaves the silence (seen at the clock's next look)", {}, ["implementer waits on tester", "start", 91, "check", 3, "lead answers", "check"], [1], "talking"],
    ["R6.6 a paused team gets no round, however long", {}, ["start", 60, "pause", 3600, "check"], [], "paused"],
    ["R6.6 Resume counts from zero: just under L after it", {}, ["start", 60, "pause", 3600, "resume", 89, "check"], [], "progressing"],
    ["R6.6 ... and past L after it", {}, ["start", 60, "pause", 3600, "resume", 91, "check"], [1], "progressing"],
    ["R6.5 a restart in the quiet counts from the launch: nothing at the old limit", {}, ["start", 60, "restart", 31, "check"], [], "progressing"],
    ["R6.5 ... a round at L after the launch", {}, ["start", 60, "restart", 91, "check"], [1], "progressing"],
    ["R6.5 a restart after a round does not send the same period's round again", {}, ["start", 91, "check", 9, "restart", 2, "check", 20, "check"], [1], "progressing"],
    ["R6.5 a restart after 8 hours: no round the moment the launch ends", {}, ["start", "after 8 h", "restart", "check"], [], "progressing"],
    ["R6.5 ... the first at L after the launch", {}, ["start", "after 8 h", "restart", 91, "check"], [1], "progressing"],
    ["status waiting from the lead holds the rounds", {}, ["start", 50, "lead waits for user", 41, "check", 100, "check"], [], "stalled"],
    ["status waiting, then progress: the rounds are back L after that", {}, ["start", 50, "lead waits for user", 41, "lead answers", "check", 91, "check"], [1], "stalled"],
    ["a status that is no longer waiting lifts the hold", {}, ["start", 50, "lead waits for user", 10, "lead status clear", 31, "check"], [1], "progressing"],
    ["N5.3 status waiting holds the periodic round", { cadence: true }, ["start", 50, "lead waits for user", 41, "tick"], [], "progressing"],
    ["N5.3 ... every periodic round while it waits", { cadence: true }, ["start", 50, "lead waits for user", 41, "tick", 91, "tick"], [], "stalled"],
    ["N5.3 progress after the question: the next periodic round is typed", { cadence: true }, ["start", 50, "lead waits for user", 10, "lead answers", 31, "tick"], [1], "talking"],
    ["N5.3 a status that is no longer waiting lifts the hold on the periodic round", { cadence: true }, ["start", 50, "lead waits for user", 10, "lead status clear", 31, "tick"], [1], "progressing"],
    ["N5.3 a question asked before the last progress holds nothing", { cadence: true }, ["start", 10, "lead waits for user", 10, "lead answers", 71, "tick"], [1], "talking"],
    // A question older than the launch still holds the rounds.
    ["N6.2 a restart while the lead waits for the user: no quiet round", {}, ["start", 10, "lead waits for user", 5, "restart", 91, "check"], [], "progressing"],
    ["N6.2 ... and it keeps holding, much later", {}, ["start", 50, "lead waits for user", 41, "restart", 91, "check", 100, "check"], [], "stalled"],
    ["N6.2 a restart while the lead waits: no periodic round either", { cadence: true }, ["start", 10, "lead waits for user", 5, "restart", 91, "tick"], [], "progressing"],
    ["N6.2 a restart, then the user answers and the lead moves: the rounds are back L after that", {}, ["start", 50, "lead waits for user", 41, "restart", "lead status clear", "lead answers", "check", 91, "check"], [1], "talking"],
    ["N6.2 a question asked before the last progress, then a restart: the clock still counts from the launch", {}, ["start", 10, "lead waits for user", 10, "lead answers", 10, "restart", 31, "check"], [], "talking"],
    ["N6.2 no Lead section, the rhythm's role (the lead) waits for the user, a restart: no periodic round", { lead: false, cadence: true }, ["start", 10, "lead waits for user", 5, "restart", 91, "tick"], [], "progressing"],
    ["N6.2 the other order: a restart, then the lead waits for the user: no quiet round", {}, ["start", 10, "restart", 5, "lead waits for user", 91, "check"], [], "progressing"],
    ["N6.2 a restart while only a non-lead role waits for the user: the lead's clock counts from the launch", {}, ["start", 50, "implementer waits for user", 41, "restart", 89, "check"], [], "progressing"],
    ["N6.2 ... and its round comes L after the launch", {}, ["start", 50, "implementer waits for user", 41, "restart", 91, "check"], [1], "progressing"],
    ["N6.2 a restart while the lead waits, the user answers in the pane: the hold lifts, the old quiet clock goes on", {}, ["start", 50, "lead waits for user", 41, "restart", 10, "lead status clear", "check"], [1], "progressing"],
    ["K3 a busy lead, free before the retry: the owed round is typed at the retry", { cadence: true }, ["start", 91, "lead busy", "tick", "lead free", "retry"], [1], "progressing"],
    ["K3 a lead on a draft, the draft sent before the retry", { cadence: true }, ["start", 91, "lead draft", "tick", "lead free", "retry"], [1], "progressing"],
    ["K3 still busy at the retry: it tries again, and again", { cadence: true }, ["start", 91, "lead busy", "tick", "retry", "retry", "lead free", "retry"], [1], "progressing"],
    ["K3 busy through four retries, then free: the owed round goes at the next look", { cadence: true }, ["start", 91, "lead busy", "tick", "retry", "retry", "retry", "retry", "lead free", "retry"], [1], "progressing"],
    ["K3 a Pause cancels the retry", { cadence: true }, ["start", 91, "lead busy", "tick", "pause", "lead free", "retry"], [], "paused"],
    ["K3 the next beat after a retry that worked is the next number", { cadence: true }, ["start", 91, "lead busy", "tick", "lead free", "retry", 80, "tick"], [1, 2], "progressing"],
    ["K3 a free lead needs no retry", { cadence: true }, ["start", 91, "tick", "retry"], [1], "progressing"],
    ["R6.7 a team without a lead gets no round", { lead: false }, ["start", 91, "check", 100, "check"], [], "stalled"],
  ];

  for (const [name, opts, steps, expected, status] of CASES) {
    silenceTest(`silence | ${name}`, opts, async (t) => {
      await t.run(...steps);
      assert.deepEqual(t.rounds(), expected, "rounds the lead got");
      assert.equal((await t.live()).status, status, "status");
    });
  }

  silenceTest("the round names who waits on whom and since when, from the log", async (t) => {
    await t.run("implementer waits on tester", "start", 91, "check");
    const text = t.toLead().at(-1).text;
    assert.match(text, /Aya round 1:/);
    assert.match(text, /implementer waits for tester since \d\d:\d\d \(\d+ min\)/);
    assert.match(text, /aya status waiting/);
    assert.doesNotMatch(text, /Supervision from Aya/);
  });

  silenceTest("a cadence round due with the quiet clock carries its text: who waits on whom", { cadence: true }, async (t) => {
    await t.run("implementer waits on tester", "start", 90, "tick");
    assert.match(t.toLead().at(-1).text, /^\[team ux-review \| from aya \| [^\]]+\] Aya round 1: no progress since .*implementer waits for tester/);
    const plain = await world({ cadence: true });
    try {
      await plain.run("start", 10, "lead reports", 80, "tick");
      assert.match(plain.toLead().at(-1).text, /Aya round 1: run your round as the team protocol says\./);
    } finally {
      plain.cleanup();
    }
  });

  silenceTest("a rhythm round carries the digest: what changed since, then only the sections with news", { cadence: true }, async (t) => {
    await t.run("start", 10, "lead reports", 80, "tick");
    const text = t.toLead().at(-1).text;
    assert.match(text, /Aya round 1: run your round as the team protocol says\. Since \d\d:\d\d \(no Aya round before\): \+1 message, no commits\./);
    assert.doesNotMatch(text, /Load since|Needs action|Waiting on you|Refused sends/);
  });

  silenceTest("a rhythm round ends with the team's status command output", { cadence: true, status: "echo athena: gemma-best; echo laptop: nothing loaded" }, async (t) => {
    await t.run("start", 10, "lead reports", 80, "tick");
    const text = t.toLead().at(-1).text;
    assert.match(text, /Aya round 1: run your round as the team protocol says\..*Status \(from the team's command\): athena: gemma-best \| laptop: nothing loaded/);
    assert.equal(text.split("Status (from the team's command)").length, 2, "the section's title once");
  });

  // A team with a lead and no cadence gets only these rounds: each carries the status too, once.
  const STATUS = "echo athena: gemma-best";
  const STATUS_LINE = /Status \(from the team's command\): athena: gemma-best/;
  silenceTest("a silence round ends with the team's status command output", { status: STATUS }, async (t) => {
    await t.run("start", 91, "check");
    const text = t.toLead().at(-1).text;
    assert.match(text, /Aya round 1: no progress since /);
    assert.match(text, STATUS_LINE);
    assert.equal(text.split("Status (from the team's command)").length, 2, "the section's title once");
  });

  silenceTest("a stall round ends with the team's status command output", { status: STATUS }, async (t) => {
    await t.run("start", 91, "check", 30, "check", 30, "check", 30, "check");
    const text = t.toLead().at(-1).text;
    assert.match(text, /Aya round 4: stalled: /);
    assert.match(text, STATUS_LINE);
    assert.equal(text.split("Status (from the team's command)").length, 2, "the section's title once");
  });

  silenceTest("a cadence round due with the quiet clock carries the status too", { cadence: true, status: STATUS }, async (t) => {
    await t.run("implementer waits on tester", "start", 90, "tick");
    const text = t.toLead().at(-1).text;
    assert.match(text, /Aya round 1: no progress since /);
    assert.match(text, STATUS_LINE);
  });

  // An open "says it sent" claim rides on every lead round, before the status command's output; none, no section.
  const CLAIM_LINE = "Said it sent: implementer says it sent to tester, nothing arrived.";
  const claimed = (t) =>
    writeFileSync(join(t.store.dir, "claims.json"), JSON.stringify({ implementer: { checked: 0, claims: [{ to: "tester", turn: 0, since: "2026-09-30T09:59:00.000Z" }] } }));
  // [round, team options, steps, first words of the round]
  const ROUND_KINDS = [
    ["rhythm", { cadence: true }, ["start", 10, "lead reports", 80, "tick"], /Aya round 1: run your round as the team protocol says\./],
    ["silence", {}, ["start", 91, "check"], /Aya round 1: no progress since /],
    ["stall", {}, ["start", 91, "check", 30, "check", 30, "check", 30, "check"], /Aya round 4: stalled: /],
  ];
  for (const [kind, opts, steps, opening] of ROUND_KINDS) {
    for (const claim of [true, false]) {
      silenceTest(`a ${kind} round ${claim ? "carries the open claim once, before the status" : "has no claim section without a claim"}`, { ...opts, status: STATUS }, async (t) => {
        if (claim) claimed(t);
        await t.run(...steps);
        const text = t.toLead().at(-1).text;
        assert.match(text, opening);
        assert.equal(text.split("Said it sent:").length - 1, claim ? 1 : 0, text);
        if (claim) assert.match(text, new RegExp(`${literal(CLAIM_LINE)} Status \\(from the team's command\\): athena: gemma-best$`));
      });
    }
  }

  // A round the lead's pane does not take stays due and is looked at again each minute: the command runs once it goes.
  for (const [how, block, unblock] of [["busy", "lead busy", "lead free"], ["a draft", "lead draft", "lead free"]]) {
    const marker = join(mkdtempSync(join(tmpdir(), "aya-status-runs-")), "runs");
    silenceTest(`a lead ${how}: the status command does not run while the round waits, then runs once with it`, { status: `echo run >> ${marker}; echo athena: gemma-best` }, async (t) => {
      const runs = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);
      await t.run("start", block, 91, "check", 30, "check", 30, "check");
      assert.deepEqual(t.rounds(), []);
      assert.equal(runs(), 0, "no run for a round not typed");
      await t.run(unblock, "check");
      assert.equal(t.rounds().length, 1);
      assert.match(t.toLead().at(-1).text, STATUS_LINE);
      assert.equal(runs(), 1);
    });
  }

  silenceTest("a rhythm round's digest reads the store: refusals, held messages, the round before", { cadence: true }, async (t) => {
    await t.run("start", 10, "lead reports", 80, "tick");
    await t.store.recordRefusal({ from: "implementer", to: "author", reason: "no such role", text: "a finding" });
    t.w.holds[IMPLEMENTER_PANE(t)] = HOLD_DRAFT;
    await t.send(t.w.paneIds.lead, "implementer", "decision: ship it");
    await t.run("commit", 90, "tick");
    const text = t.toLead().at(-1).text;
    assert.match(text, /Aya round 2: run your round as the team protocol says\. Since \d\d:\d\d: \+1 message, \+1 commit \([^)]*\), 1 held\..*Refused sends: implementer -> "author" \(no such role\): "a finding"\.$/);
  });

  silenceTest("a rhythm round names idle roles from the panes' busy state", { cadence: true }, async (t) => {
    await t.run("start", 10, "lead reports", 80, "tick");
    // The log is stamped with the wall clock and the digest counts wall-clock minutes: the fake clock jumps past them.
    t.w.now = Date.now() + (DIGEST_IDLE_MIN + 5) * WALL_MINUTE_MS;
    await t.run("commit", "tick");
    assert.match(t.toLead().at(-1).text, new RegExp(`Idle over ${DIGEST_IDLE_MIN} min: implementer\\.`));
    t.w.busy.add(IMPLEMENTER_PANE(t));
    await t.run("commit", 90, "tick");
    assert.doesNotMatch(t.toLead().at(-1).text, /Idle over/);
    delete t.w.deps.busy;
    await t.run("commit", 90, "tick");
    assert.match(t.toLead().at(-1).text, new RegExp(`Idle over ${DIGEST_IDLE_MIN} min \\(not known whether busy now\\): implementer\\.`));
  });

  silenceTest("a rhythm round counts a turn in the debug log as activity, as aya team stats --now does", { cadence: true }, async (t) => {
    await t.run("start", 10, "lead reports", 80, "tick");
    t.w.now = Date.now() + (DIGEST_IDLE_MIN + 5) * WALL_MINUTE_MS;
    // A message typed to the implementer a minute ago started its turn; the log has the message's earlier send time.
    appendFileSync(join(t.store.dir, "debug.jsonl"), `${JSON.stringify({ time: new Date(t.w.now - WALL_MINUTE_MS).toISOString(), event: "turn", to: "implementer", from: "tester", id: 1 })}\n`);
    await t.run("commit", "tick");
    const live = t.toLead().at(-1).text;
    assert.doesNotMatch(live, /Idle over/);
    const now = digestOneLine(digestFromFiles("ux-review", readTeamFiles(t.store.dir), t.w.now));
    assert.doesNotMatch(now, /Idle over/, "--now agrees");
  });

  silenceTest("a failing status command is one line in the round, and the round still goes out", { cadence: true, status: "exit 3" }, async (t) => {
    await t.run("start", 10, "lead reports", 80, "tick");
    assert.match(t.toLead().at(-1).text, /Aya round 1: run your round as the team protocol says\..*Status \(from the team's command\): status command failed: exit 3/);
  });

  silenceTest("the round with nobody waiting says so", async (t) => {
    await t.run("start", 91, "check");
    assert.match(t.toLead().at(-1).text, /Aya round 1: .*No role has an unanswered message/);
  });

  test("every running team arms one clock on Start, with a lead or without", async () => {
    for (const opts of [{}, { cadence: true }, { lead: false }]) {
      const t = await world(opts);
      try {
        await t.run("start");
        assert.equal(t.w.jobs.length, 1, JSON.stringify(opts));
      } finally {
        t.cleanup();
      }
    }
  });

  silenceTest("no extra supervision message: three silence rounds, the round due at the stall says so, then nothing", async (t) => {
    await t.run("implementer waits on tester", "start", 91, "check", 30, "check", 30, "check", 30, "check", 120, "check");
    const aya = t.toLead();
    assert.deepEqual(aya.map((m) => m.text.match(/Aya round (\d): (no progress|stalled)/)?.slice(1).join(" ")), ["1 no progress", "2 no progress", "3 no progress", "4 stalled"]);
    assert.match(aya[3].text, /implementer waits for tester/, "the stall round names who waits on whom");
    assert.ok(!aya.some((m) => /Supervision from Aya/.test(m.text)));
  });

  silenceTest("a busy lead is tried once per window, so the log is not flooded", async (t) => {
    await t.run("start", "lead busy", 91);
    for (let i = 0; i < 12; i++) await t.run(2, "check");
    const fromAya = (await t.store.log()).filter((m) => m.from === "aya" && m.to === "tester" && /Aya round/.test(m.text));
    assert.ok(fromAya.length <= 1, `${fromAya.length} messages in one window`);
    assert.equal((await t.store.progress()).unreached, undefined, "a busy lead is working, never a missed round");
  });

  silenceTest("the silence clock is its own field in the state and survives a restart", async (t) => {
    await t.run("start");
    assert.equal(await t.store.silenceRoundAt(), null);
    await t.run(91, "check");
    const at = await t.store.silenceRoundAt();
    assert.equal(at, t.w.now);
    assert.equal(await t.store.lastRound(), 1);
    await t.run("restart");
    assert.equal(await t.store.silenceRoundAt(), at);
  });

  test("a lead whose pane was replaced gets the round in the new pane; one whose pane is closed is a miss, not a crash", async () => {
    const t = await world();
    try {
      await t.run("start", "lead pane replaced", 91, "check");
      assert.equal(t.w.typed.filter((m) => m.pane === t.w.paneIds.replacement && /Aya round 1:/.test(m.text)).length, 1);
      assert.equal(t.w.typed.filter((m) => m.pane === t.w.paneIds.lead && /Aya round 1:/.test(m.text)).length, 0);
    } finally {
      t.cleanup();
    }
    const closed = await world();
    try {
      await closed.run("start", "lead pane closed", 91, "check");
      assert.deepEqual(closed.rounds(), []);
      const missed = (await closed.store.log()).filter((m) => m.from === "aya" && /^Aya round 1 skipped: /.test(m.text));
      assert.equal(missed.length, 1, "the miss is logged once, as a skipped round");
    } finally {
      closed.cleanup();
    }
  });

  const STALL_CASES = [
    ["a team with no rhythm and a lead", {}, ["start", T / S + 1], "stalled", true],
    ["a team with no rhythm and no lead", { lead: false }, ["start", T / S + 1], "stalled", true],
    ["a busy lead: no round ever typed, still stalled", {}, ["start", "lead busy", 91, "check", 30, "check", 30, "check", 30, "check"], "stalled", true],
    ["a lead whose pane is gone: unreachable, and stalled underneath", {}, ["start", "lead gone", 91, "check", 30, "check", 30, "check", 30, "check"], "unreachable", true],
    ["a lead with a draft in its composer", {}, ["start", "lead draft", 91, "check", 30, "check", 30, "check", 30, "check"], "unreachable", true],
    ["just under the limit", {}, ["start", T / S - 1], "progressing", false],
    ["exactly at the limit", {}, ["start", T / S], "stalled", true],
    ["a message does not restart it: talk is not progress", {}, ["start", T / S - 1, "lead answers", "check", 10], "stalled", true],
    ["a commit restarts it", {}, ["start", T / S - 1, "commit", "check", 10], "progressing", false],
    ["a cadence team stalls on the clock too", { cadence: true }, ["start", "lead busy", T / S + 1], "stalled", true],
  ];
  for (const [name, opts, steps, status, stalled] of STALL_CASES) {
    silenceTest(`stalled by the clock | ${name}`, opts, async (t) => {
      await t.run(...steps);
      const live = await t.live();
      assert.equal(live.status, status);
      assert.equal(live.stalledSince !== null, stalled, "stalledSince");
    });
  }

  silenceTest("stalled by the clock: the clock's next look after a commit says 'progressing'; a message does not end it", async (t) => {
    await t.run("start", T / S + 1);
    assert.equal((await t.live()).status, "stalled");
    await t.run("lead answers", "check");
    assert.equal((await t.live()).status, "stalled", "talk is not progress");
    await t.run("commit");
    assert.equal((await t.live()).status, "stalled", "the window does not read git");
    await t.run("check");
    assert.equal((await t.live()).status, "progressing");
    assert.equal((await t.live()).stalledSince, null);
    await t.run(T / S + 1);
    assert.equal((await t.live()).status, "stalled", "and it can stall again");
    await t.run("commit", "check");
    assert.equal((await t.live()).status, "progressing", "a commit ends it again");
  });

  test("a team without a cadence is not 'unwatched': the window says what it watches for", async () => {
    const t = await world();
    try {
      await t.run("start");
      const live = await t.live();
      assert.notEqual(live.status, "unwatched");
      assert.deepEqual(live.silence, { askAfterMin: 30, everyMin: null, stalledAfterMin: 60 });
    } finally {
      t.cleanup();
    }
    const none = await world({ lead: false });
    try {
      await none.run("start");
      assert.deepEqual((await none.live()).silence, { askAfterMin: null, everyMin: null, stalledAfterMin: 60 });
    } finally {
      none.cleanup();
    }
  });

  silenceTest("a Save re-arms the clock; one that removes the lead leaves a clock that types no round", async (t) => {
    await t.run("start");
    const first = t.w.jobs.at(-1);
    await t.run("refresh");
    assert.equal(first.cancelled, true, "the old clock is cancelled");
    assert.equal(t.w.jobs.length, 2);
    assert.equal(t.w.jobs.at(-1).cancelled, false);
    await t.store.saveDefinition(TEAM({ lead: false }));
    await t.run("refresh");
    assert.equal(t.w.jobs.filter((j) => !j.cancelled).length, 1, "one clock, still watching the repo");
    await t.run(200, "check");
    assert.deepEqual(t.rounds(), [], "no lead, no round");
  });

  silenceTest("removing the team cancels the clock", async (t) => {
    await t.run("start");
    const job = t.w.jobs.at(-1);
    rmSync(join(t.w.teamHome, "..", "game", ".aya", "teams", "ux-review.md"), { force: true });
    await t.w.runner.remove("game", "ux-review");
    assert.equal(job.cancelled, true);
  });

  silenceTest("the rounds from the silence share the cadence numbering", { cadence: true }, async (t) => {
    await t.run("start", 90, "tick", 30, "check", 50, "tick");
    assert.deepEqual(t.rounds(), [1, 2, 3]);
  });
});
