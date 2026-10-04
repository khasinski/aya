// One cadence "minute" lasts 3 s and a screen counts as blocked after 6 s here, so the cadence below
// (10 min = 30 s) and the 60 min stall limit (3 min, six beats) never exceed 3 minutes.
process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_E2E_TEAM_BLOCKED_MS = "6000";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { UNREACHED_ROUNDS, teamStatus, teamLiveness, parseProgress } = await import("../dist-electron/team-progress.js");
const { BLOCKED_AFTER_MS } = await import("../dist-electron/team-times.js");
const { STALL_AFTER_MS } = await import("../dist-electron/team-times.js");
const { listTeams } = await import("../dist-electron/team-admin.js");

const TEAM = (cadence = true) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report
${cadence ? "\n## Cadence\nimplementer every 10 min\n" : ""}`;
const ROLES = ["tester", "implementer"];
const { HOLD_APPROVAL: APPROVAL, HOLD_CHOICE: CHOICE, HOLD_NOT_RUNNING, HOLD_STARTING, HOLD_DRAFT, HOLD_APPROVE_AYA, HOLD_SHELL } = await import("../dist-electron/pane-holds.js");
const ROUND_MS = 10 * TEST_TEAM_MINUTE_MS;

async function world({ cadence = true } = {}) {
  const { teamHome, project, cleanup } = teamProject("aya-live-", { teamFile: TEAM(cadence) });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { holds: { "pane-t": null, "pane-i": null }, busy: new Set(), afters: [], commit: "c0", typed: [], scheduled: [], now: Date.parse("2026-09-30T10:00:00Z") };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text }),
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => w.commit,
    busy: async (pane) => w.busy.has(pane),
  };
  const schedule = (fn, ms) => (w.scheduled.push({ fn, ms }), () => {});
  const make = () => ((w.scheduled.length = 0), (w.runner = new TeamRunner(w.deps, schedule, () => w.now)));
  make();
  const rounds = () => w.typed.filter((t) => t.pane === "pane-i").flatMap((t) => t.text.match(/Round (\d+):/)?.[1] ?? []).map(Number);
  // The lead answers each round "ok", so the stall below is not the round brake.
  let answered = 0;
  const look = async () => {
    await w.scheduled.at(-1)?.fn();
    for (; answered < rounds().length; answered++) {
      await store.append({ from: "implementer", to: "tester", commit: null, text: "ok", delivered: true, time: new Date(w.now).toISOString() });
    }
  };
  const liveness = () => teamLiveness(store, ROLES, w.deps.holdReason, { cadence: cadence ? 10 : null, lead: cadence }, w.now);
  const send = (from, to, text) => handleTeamRequest({ type: "team-send", role: to, text }, from, w.deps).catch(() => {});
  const ACTIONS = {
    start: () => w.runner.start("game", "ux-review"),
    pause: () => w.runner.pause("game", "ux-review"),
    resume: () => w.runner.resume("game", "ux-review"),
    restart: async () => (make(), w.runner.restore()),
    tick: async () => {
      w.now += ROUND_MS;
      await look();
    },
    peer: () => send("pane-t", "implementer", "report: the build is green and the timer test passes"),
    ack: () => send("pane-t", "implementer", "ok"),
    "peer to blocked tester": () => send("pane-i", "tester", "please look at the new build"),
    commit: () => void (w.commit = `c${Math.random()}`),
    "commit null": () => void (w.commit = null),
    "commit back": () => void (w.commit = "c0"),
    window: () => liveness(),
    watch: look,
    "3 minutes": () => void (w.now += BLOCKED_AFTER_MS + 1_000),
    "implementer approval": () => void (w.holds["pane-i"] = APPROVAL),
    "tester approval": () => void (w.holds["pane-t"] = APPROVAL),
    "tester held": () => void (w.holds["pane-t"] = HOLD_DRAFT),
    "tester aya approval": () => void (w.holds["pane-t"] = HOLD_APPROVE_AYA),
    "tester choice": () => void (w.holds["pane-t"] = CHOICE),
    "tester restarting": () => void (w.holds["pane-t"] = HOLD_NOT_RUNNING),
    "tester starting": () => void (w.holds["pane-t"] = HOLD_STARTING),
    "user resolves": () => void ((w.holds = { "pane-t": null, "pane-i": null }), w.busy.clear()),
    "implementer not running": () => void (w.holds["pane-i"] = HOLD_NOT_RUNNING),
    "implementer shell": () => void (w.holds["pane-i"] = HOLD_SHELL),
    "implementer draft": () => void (w.holds["pane-i"] = HOLD_DRAFT),
    "implementer busy": () => void w.busy.add("pane-i"),
    "implementer starting": () => void (w.holds["pane-i"] = HOLD_STARTING),
    "implementer free": () => void (w.holds["pane-i"] = null),
    "implementer pane closed": () => store.releasePane("pane-i"),
    "implementer pane back": () => store.assign("implementer", "pane-i"),
    "a late relaunch": async () => (make(), (w.now += 2 * ROUND_MS), w.runner.restore()),
    "due tick": look,
    retries: look,
  };
  const run = async (...actions) => {
    for (const a of actions) await ACTIONS[a]();
  };
  return { ...w, w, store, rounds, liveness, run, send, cleanup };
}

const liveTest = (name, ...args) => {
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

const ticks = (n) => Array(n).fill("tick");
const K = UNREACHED_ROUNDS;
// Beats until the repo's clock runs out: the round due then says stalled.
const STALL = STALL_AFTER_MS / ROUND_MS;

const { FRESH_PROGRESS, KNOWN_COMMITS_KEPT, observe, noteRound, resetProgress } = await import("../dist-electron/team-progress.js");
const { ROUND_CHECK_MS, ROUND_SLACK_MS } = await import("../dist-electron/team-times.js");

// Every world owns its home, store, runner, hold map and clock. No case writes
// process-wide agent status, so the filesystem work can run independently.
describe("liveness with independent teams", { concurrency: 16 }, () => {
  test("K is the 3 missed rounds and STALL the 60 min the tables below spell out", () => {
    assert.deepEqual([K, STALL], [3, 6]);
  });

  // running and paused never both hold (TeamStore.state), so no row has both.
  const STATUS_TABLE = [
    [{ running: false, paused: false, stalled: false, blocked: [] }, "never started"],
    [{ running: false, paused: true, stalled: true, blocked: ["tester"] }, "paused"],
    [{ running: true, paused: false, stalled: false, blocked: [] }, "progressing"],
    [{ running: true, paused: false, stalled: false, blocked: [], talking: true }, "talking"],
    [{ running: true, paused: false, stalled: true, blocked: [], talking: true }, "stalled"],
    [{ running: true, paused: false, stalled: true, blocked: [] }, "stalled"],
    [{ running: true, paused: false, stalled: false, blocked: ["tester"] }, "blocked"],
    [{ running: true, paused: false, stalled: true, blocked: ["tester"] }, "blocked"],
    [{ running: false, paused: true, stalled: false, blocked: [] }, "paused"],
    [{ running: true, paused: false, stalled: false, blocked: [], unreached: true }, "unreachable"],
    [{ running: true, paused: false, stalled: true, blocked: [], unreached: true }, "unreachable"],
    [{ running: true, paused: false, stalled: false, blocked: ["tester"], unreached: true }, "blocked"],
    [{ running: false, paused: false, stalled: false, blocked: [], unreached: true }, "never started"],
  ];
  for (const [input, expected] of STATUS_TABLE) {
    test(`teamStatus | ${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(teamStatus(input), expected);
    });
  }

  // Rounds nobody answers do not stall a team; the repo's clock does, at beat STALL, whose round says so.
  const UPTO = (n) => Array.from({ length: n }, (_, i) => i + 1);
  const CASES = [
    ["never started: a tick has nothing to run", [], [], "never started", true],
    ["running: rounds go out while nothing answers", ["start", ...ticks(K)], UPTO(K), "progressing"],
    ["running: the round at the stall says so, the one after is skipped", ["start", ...ticks(STALL + 1)], UPTO(STALL), "stalled"],
    ["stalled stays stalled and types nothing more", ["start", ...ticks(STALL + 4)], UPTO(STALL), "stalled"],
    ["stalled + peer message: still stalled, talk is not progress", ["start", ...ticks(STALL + 1), "peer", "tick"], UPTO(STALL), "stalled"],
    ["stalled + new commit: the next tick is a round again", ["start", ...ticks(STALL + 1), "commit", "tick"], UPTO(STALL + 1), "progressing"],
    ["a commit in between restarts the clock", ["start", "tick", "tick", "commit", ...ticks(STALL)], UPTO(STALL + 2), "progressing"],
    // The time Aya was closed is not the team's.
    ["a restart in between starts the repo's clock over", ["start", "tick", "restart", ...ticks(STALL)], UPTO(STALL + 1), "stalled"],
    ["stalled + restart: still stalled, still skipped", ["start", ...ticks(STALL + 1), "restart", "tick"], UPTO(STALL), "stalled"],
    ["stalled + restart + commit: resumes", ["start", ...ticks(STALL + 1), "restart", "commit", "tick"], UPTO(STALL + 1), "progressing"],
    ["stalled + pause: paused shows, no round", ["start", ...ticks(STALL + 1), "pause", "tick"], UPTO(STALL), "paused"],
    ["stalled + pause + resume: a fresh clock", ["start", ...ticks(STALL + 1), "pause", "resume", "tick"], UPTO(STALL + 1), "progressing"],
    ["a one-word ack is not progress", ["start", ...Array(STALL + 1).fill(["ack", "tick"]).flat()], UPTO(STALL), "stalled"],
    ["a message held for a blocked role is not progress", ["start", "tester approval", ...Array(STALL + 1).fill(["peer to blocked tester", "tick"]).flat()], UPTO(STALL), "blocked"],
    ["a commit that flaps to unknown and back is not progress", ["start", "tick", "commit null", "tick", "commit back", "tick", "commit null", ...ticks(STALL - 2)], UPTO(STALL), "stalled"],
    ["a real commit made while HEAD was unreadable is still progress", ["start", "tick", "tick", "commit null", "tick", "commit", ...ticks(STALL - 2)], UPTO(STALL + 1), "progressing"],
    ["a commit seen first after an unknown one is a baseline, not progress", ["commit null", "start", "tick", "tick", "commit", ...ticks(STALL - 1)], UPTO(STALL), "stalled"],
    ["a commit by anyone in the project directory is progress (project-wide)", ["start", ...ticks(STALL + 1), "commit", "tick"], UPTO(STALL + 1), "progressing"],
    ["stalled, then a confirmed blocked screen is answered: the next tick is a round again", ["start", ...ticks(STALL + 1), "tester approval", "watch", "3 minutes", "watch", "user resolves", "watch", "tick"], UPTO(STALL + 1), "progressing"],
    ["stalled, a screen that was up for seconds is answered: no wake-up", ["start", ...ticks(STALL + 1), "tester approval", "watch", "user resolves", "watch", "tick"], UPTO(STALL), "stalled"],
    ["a blocked screen answered before the stall: the stall still comes STALL beats after", ["start", "tester approval", "watch", "3 minutes", "user resolves", "watch", ...ticks(STALL + 1)], UPTO(STALL + 1), "stalled"],
    ["stalled + Start again after pause: a fresh clock", ["start", ...ticks(STALL + 1), "pause", "start", "tick"], UPTO(STALL + 1), "progressing"],
  ];
  for (const [label, actions, expectedRounds, status, neverStarted] of CASES) {
    liveTest(`liveness | ${label}`, async (t) => {
      await t.run(...actions);
      assert.deepEqual(t.rounds(), expectedRounds);
      const live = await t.liveness();
      assert.equal(live.status, status);
      if (neverStarted) assert.equal(t.w.scheduled.length, 0);
    });
  }

  const skips = async (t) => (await t.store.log()).filter((m) => m.from === "aya" && /^round \d+ skipped: /.test(m.text)).map((m) => m.text);

  liveTest("a skipped round is logged once in the team log, never typed, and says why", async (t) => {
    await t.run("start", ...ticks(STALL + 4));
    const skipped = await skips(t);
    assert.equal(skipped.length, 1, skipped.join("\n"));
    assert.match(skipped[0], new RegExp(`^round ${STALL + 1} skipped: stalled: no change to the repo since \\d\\d:\\d\\d$`));
    assert.equal((await t.store.log()).filter((m) => m.text.startsWith("Round")).length, STALL, "no round typed while stalled");
  });

  const BLOCKED_CASES = [
    ["implementer approval for one tick is not yet blocked", ["start", "implementer approval", "tick"], []],
    ["implementer approval for two ticks: blocked", ["start", "implementer approval", "tick", "tick"], ["implementer"]],
    ["tester approval (the plan-mode case) for two ticks: blocked, the leader still gets rounds", ["start", "tester approval", "tick", "tick"], ["tester"]],
    ["tester numbered choice for two ticks: blocked", ["start", "tester choice", "tick", "tick"], ["tester"]],
    ["the user resolves it: not blocked at once, before any tick", ["start", "tester approval", "tick", "tick", "user resolves"], []],
    ["blocked, one free read, blocked again: still blocked (a glitch is not an answer)", ["start", "tester approval", "tick", "user resolves", "tick", "tester approval", "tick"], ["tester"]],
    ["blocked, two free reads, blocked again: the count starts over", ["start", "tester approval", "tick", "user resolves", "tick", "tick", "tester approval", "tick"], []],
    ["no beat at all: seen by the clock's look, still up 3 minutes later: blocked", ["start", "tester approval", "watch", "3 minutes"], ["tester"]],
    ["no beat at all: up for a moment only: not yet", ["start", "tester approval", "watch"], []],
    ["the pane restarts (not running) while blocked: still blocked, the count is not lost", ["start", "tester approval", "watch", "3 minutes", "tester restarting", "watch"], ["tester"]],
    ["...and comes back on the same screen: blocked at once", ["start", "tester approval", "watch", "3 minutes", "tester restarting", "watch", "tester approval", "watch"], ["tester"]],
    ["...but starting up is not the user answering either", ["start", "tester approval", "watch", "3 minutes", "tester starting", "watch"], ["tester"]],
    ["a different screen at the second tick restarts the count", ["start", "tester approval", "tick", "tester choice", "tick"], []],
    ["...and blocked once the new screen has stayed two ticks", ["start", "tester approval", "tick", "tester choice", "tick", "tick"], ["tester"]],
    ["blocked + restart: still blocked (persisted)", ["start", "tester approval", "tick", "tick", "restart"], ["tester"]],
    ["blocked + pause: no role is reported for a paused team", ["start", "tester approval", "tick", "tick", "pause"], []],
  ];
  for (const [label, actions, blocked] of BLOCKED_CASES) {
    liveTest(`blocked role | ${label}`, async (t) => {
      await t.run(...actions);
      const live = await t.liveness();
      assert.deepEqual(live.blocked.map((b) => b.role), blocked);
      const expected = actions.includes("pause") ? "paused" : blocked.length ? "blocked" : "progressing";
      assert.equal(live.status, expected);
      if (!actions.includes("pause")) assert.equal(live.status === "blocked", blocked.length > 0, "blocked exactly when a role is reported");
      if (blocked.length && !actions.includes("pause")) {
        assert.equal(live.blocked[0].reason, actions.includes("tester choice") ? CHOICE : APPROVAL);
        assert.match(live.blocked[0].since, /^\d{4}-\d\d-\d\dT/);
      }
    });
  }

  liveTest("a leader held on an approval screen gets no round, and the first goes out as soon as it is answered", async (t) => {
    await t.run("start", "implementer approval", ...ticks(K + 1));
    assert.deepEqual(t.rounds(), []);
    await t.run("user resolves", "tick");
    assert.deepEqual(t.rounds(), [1], "the first round goes out as soon as the pane frees");
    assert.notEqual((await t.liveness()).status, "stalled");
  });

  liveTest("a second stall after a resume is logged again", async (t) => {
    await t.run("start", ...ticks(STALL + 1), "commit", ...ticks(STALL + 2));
    assert.equal((await skips(t)).length, 2);
  });

  liveTest("stalledSince is the last sign of life, moved on by a commit", async (t) => {
    await t.run("start", ...ticks(STALL + 1));
    const first = (await t.liveness()).stalledSince;
    await t.run("commit", ...ticks(STALL + 1));
    const second = (await t.liveness()).stalledSince;
    assert.ok(first && second && Date.parse(second) > Date.parse(first));
  });

  // A team with no Cadence (and so no lead) gets no rounds; its clock still records the screens and the repo.
  const NO_CADENCE = [
    ["nothing wrong: watched by the silence clock, not 'unwatched'", ["start"], "progressing", []],
    ["a tester on the approval screen for 3 minutes: blocked", ["start", "tester approval", "watch", "3 minutes"], "blocked", ["tester"]],
    ["the same screen for seconds only", ["start", "tester approval", "watch"], "progressing", []],
    ["answered again: back to no rounds", ["start", "tester approval", "watch", "3 minutes", "user resolves"], "progressing", []],
    ["paused", ["start", "tester approval", "watch", "3 minutes", "pause"], "paused", []],
    ["never started", ["tester approval", "watch", "3 minutes"], "never started", []],
  ];
  for (const [label, actions, status, blocked] of NO_CADENCE) {
    liveTest(`no cadence | ${label}`, { cadence: false }, async (t) => {
      await t.run(...actions);
      const live = await t.liveness();
      assert.deepEqual([live.status, live.blocked.map((b) => b.role)], [status, blocked]);
      assert.deepEqual(t.rounds(), [], "no cadence, no lead: no round");
    });
  }

  // progress.json of another shape (a downgrade, an edit) must break neither ticks nor the window.
  for (const bad of ["{}", "[]", "null", '{"idleRounds":"x"}', '{"blocked":[]}', '{"seenMessageId":1,"commit":null,"idleRounds":0,"awaiting":false,"changedAt":"x","stalledLogged":false,"blocked":{"tester":5}}', "not json", '{"seenMessageId":0,"commit":null,"idleRounds":0,"awaiting":false,"changedAt":"","stalledLogged":false,"blocked":{},"unreached":{"role":"implementer","reason":"x","since":"y","rounds":"3"}}', '{"seenMessageId":0,"commit":null,"idleRounds":"x","awaiting":false,"changedAt":"","stalledLogged":false,"blocked":{}}']) {
    liveTest(`progress.json ${bad.slice(0, 40)} is treated as empty`, async (t) => {
      await t.run("start");
      writeFileSync(join(t.store.dir, "progress.json"), bad);
      await t.run("tick");
      assert.deepEqual(t.rounds(), [1], "the round still goes out");
      const repaired = await t.store.progress();
      assert.ok(repaired && Number.isSafeInteger(repaired.seenMessageId) && typeof repaired.blocked === "object", "the next write is a valid record");
      writeFileSync(join(t.store.dir, "progress.json"), bad);
      const teams = await listTeams(t.w.deps.teamHome, (await t.w.deps.listProjects())[0], t.w.deps.holdReason);
      assert.equal(teams.length, 1);
      assert.equal(teams[0].liveness.status, "progressing");
    });
  }

  liveTest("one team with a bad progress.json does not blank the others in the window", async (t) => {
    await t.run("start");
    writeFileSync(join(t.store.dir, "progress.json"), '{"blocked":[]}');
    const project = (await t.w.deps.listProjects())[0];
    const other = join(t.w.deps.teamHome, "teams", "game", "other");
    mkdirSync(join(project.directory, ".aya", "teams"), { recursive: true });
    writeFileSync(join(project.directory, ".aya", "teams", "other.md"), TEAM().replace("# ux-review", "# other"));
    mkdirSync(other, { recursive: true });
    const teams = await listTeams(t.w.deps.teamHome, project, t.w.deps.holdReason);
    assert.deepEqual(teams.map((x) => x.name).sort(), ["other", "ux-review"]);
  });

  liveTest("Resume during a tick's round is not overwritten by the tick's late progress write", async (t) => {
    await t.run("start", "tick", "tick");
    const before = await t.store.progress();
    const deliver = t.w.deps.deliver;
    let resumed;
    t.w.deps.deliver = async (pane, text) => {
      if (/Round 3:/.test(text)) resumed = t.w.runner.resume("game", "ux-review");
      return deliver(pane, text);
    };
    await t.run("tick");
    await resumed;
    const after = await t.store.progress();
    assert.notEqual(after.repoChangedAt, before.repoChangedAt);
    assert.equal(after.repoChangedAt, new Date(t.w.now).toISOString(), "Resume's fresh clock survives");
  });

  liveTest("a team running from before progress was kept still says since when it is stalled", async (t) => {
    await t.run("start");
    rmSync(join(t.store.dir, "progress.json"));
    await t.run("restart", ...ticks(STALL + 2));
    const { stalledSince } = await t.liveness();
    assert.ok(Number.isFinite(Date.parse(stalledSince)), `stalledSince ${JSON.stringify(stalledSince)}`);
  });

  const oldBlock = (reason = APPROVAL, minutesAgo = 3, extra = {}) => ({ reason, since: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ...extra });
  const seedBlocked = (t, entry) => t.store.updateProgress((p) => ({ ...p, blocked: { tester: entry } }));
  const listed = async (t, holdReason = t.w.deps.holdReason) => (await listTeams(t.w.deps.teamHome, (await t.w.deps.listProjects())[0], holdReason))[0];

  liveTest("listTeams carries the real liveness: blocked, stalled, and progressing when nothing is wrong", async (t) => {
    // listTeams reads the real clock.
    t.w.now = Date.now();
    await t.run("start");
    assert.equal((await listed(t)).liveness.status, "progressing");
    t.w.holds["pane-t"] = APPROVAL;
    await seedBlocked(t, oldBlock());
    const blocked = (await listed(t)).liveness;
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.blocked.map((b) => b.role), ["tester"]);
    t.w.holds["pane-t"] = null;
    await t.store.updateProgress((p) => ({ ...p, blocked: {}, repoChangedAt: new Date(Date.now() - STALL_AFTER_MS - 1000).toISOString() }));
    const stalled = (await listed(t)).liveness;
    assert.equal(stalled.status, "stalled");
    assert.ok(stalled.stalledSince);
  });

  liveTest("a holdReason that throws, or a progress file that cannot be read, still lists the team", async (t) => {
    await t.run("start");
    // The window asks a pane's hold only for a role with a recorded block (or an unreached lead).
    await seedBlocked(t, oldBlock());
    const boom = async () => {
      throw new Error("pty host gone");
    };
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(format(...args));
    try {
      const unread = { status: "never started", stalledSince: null, blocked: [], unreached: null, silence: { askAfterMin: null, stalledAfterMin: 60 } };
      const byHost = await listed(t, boom);
      assert.equal(byHost.name, "ux-review");
      assert.deepEqual(byHost.liveness, unread, "a host that cannot answer degrades the status, not the list");
      rmSync(join(t.store.dir, "progress.json"));
      mkdirSync(join(t.store.dir, "progress.json"));
      const byFile = await listed(t);
      assert.equal(byFile.name, "ux-review");
      assert.equal(byFile.liveness.status, "progressing", "an unreadable progress file reads as none");
      assert.equal(warned.filter((m) => m.includes("team liveness not read")).length, 1, "the host's failure is logged, not silent");
    } finally {
      console.warn = warn;
    }
  });

  liveTest("a role waiting for the user to approve an aya command is blocked, like any approval prompt", async (t) => {
    await t.run("start", "tester aya approval", "watch", "3 minutes");
    const live = await t.liveness();
    assert.deepEqual(live.blocked.map((b) => b.role), ["tester"]);
    assert.equal(live.status, "blocked");
  });

  liveTest("a pane closed while blocked stops being 'waiting for you' after the grace, and does not wake the stall", async (t) => {
    await t.run("start", "tester approval", "watch", "3 minutes", "tester restarting", "watch");
    assert.deepEqual((await t.liveness()).blocked.map((b) => b.role), ["tester"], "a restart keeps it for now");
    t.w.now += BLOCKED_AFTER_MS;
    await t.run("watch");
    const live = await t.liveness();
    assert.deepEqual(live.blocked, []);
    assert.notEqual(live.status, "blocked");
    t.w.holds["pane-t"] = APPROVAL;
    await t.run("watch");
    assert.deepEqual((await t.liveness()).blocked, [], "back on the screen: the count starts over");
  });

  liveTest("a pane closed for a day never shows blocked", async (t) => {
    await t.run("start", "tester approval", "watch", "3 minutes", "tester restarting", "watch");
    t.w.now += 24 * 3600_000;
    assert.deepEqual((await t.liveness()).blocked, []);
  });

  liveTest("one free read after a confirmed block does not wake a stalled team; two do", async (t) => {
    await t.run("start", "tester approval", "watch", "3 minutes", ...ticks(STALL + 1));
    assert.equal((await t.liveness()).status, "blocked");
    await t.run("user resolves", "watch");
    assert.equal((await t.liveness()).status, "stalled", "one free read: still stalled");
    t.w.holds["pane-t"] = APPROVAL;
    await t.run("watch");
    assert.equal((await t.liveness()).status, "blocked", "block -> one free read -> block again stays blocked");
    await t.run("user resolves", "watch");
    assert.equal((await t.liveness()).status, "stalled");
    await t.run("watch");
    assert.equal((await t.liveness()).status, "progressing", "two free reads in a row wake it");
  });

  liveTest("the block is confirmed at exactly BLOCKED_AFTER_MS, not a millisecond before", async (t) => {
    await t.run("start", "tester approval", "watch");
    t.w.now += BLOCKED_AFTER_MS - 1;
    assert.deepEqual((await t.liveness()).blocked, []);
    t.w.now += 1;
    assert.deepEqual((await t.liveness()).blocked.map((b) => b.role), ["tester"]);
  });

  liveTest("a peer message held for a blocked role counts as progress once it is typed", async (t) => {
    await t.run("start", "tester held", "peer to blocked tester", "tick", "user resolves");
    assert.equal(await t.w.runner.redeliverWaiting(), 1);
    await t.run("tick", "tick", "tick");
    assert.deepEqual(t.rounds(), [1, 2, 3, 4], "the typed report restarted the count of silent rounds");
    assert.notEqual((await t.liveness()).status, "stalled");
  });

  liveTest("a stalled team is not woken by a held peer message once it is typed: talk is not progress", async (t) => {
    await t.run("start", ...ticks(STALL + 1));
    assert.equal((await t.liveness()).status, "stalled");
    await t.run("tester held", "peer to blocked tester", "user resolves");
    assert.equal(await t.w.runner.redeliverWaiting(), 1);
    const live = await t.liveness();
    assert.deepEqual([live.status, live.repo.messages], ["stalled", 1]);
    await t.run(...ticks(3));
    assert.deepEqual(t.rounds(), UPTO(STALL), "no round while stalled");
    assert.equal(t.w.typed.filter((m) => /stalled: no change to the repo/.test(m.text)).length, 1, "told once");
  });

  liveTest("a one-word message typed later is still not progress", async (t) => {
    await t.run("start", "tester held");
    await t.send("pane-i", "tester", "ok");
    await t.run("tick", "user resolves");
    assert.equal(await t.w.runner.redeliverWaiting(), 1);
    await t.run("tick", "tick", "tick");
    assert.deepEqual(t.rounds(), [1, 2, 3, 4]);
    const live = await t.liveness();
    assert.deepEqual([live.status, live.repo.messages], ["progressing", 0], "an ack typed late is not even talk");
  });

  liveTest("a held message that only reached the composer (Enter withheld) does not wake a stalled team", async (t) => {
    const { PaneHeldError } = await import("../dist-electron/team-control.js");
    await t.run("start", "tester held", "peer to blocked tester", "tick", "user resolves");
    const deliver = t.w.deps.deliver;
    t.w.deps.deliver = async (pane, text) => {
      if (!/Round/.test(text)) throw new PaneHeldError("shows an approval prompt", true);
      return deliver(pane, text);
    };
    await t.w.runner.redeliverWaiting();
    await t.run(...ticks(STALL));
    const live = await t.liveness();
    assert.deepEqual([live.status, live.repo.messages], ["stalled", 0], "not even talk");
  });

  // A leader whose pane cannot take a round gets none, and nothing goes silent: K untyped rounds in a row are reported.
  const UNREACHED = [
    ["leader pane not running for K ticks", ["start", "implementer not running", ...ticks(K)], "unreachable", "implementer"],
    ["leader dropped to a shell for K ticks", ["start", "implementer shell", ...ticks(K)], "unreachable", "implementer"],
    ["leader with a draft in its composer for K ticks", ["start", "implementer draft", ...ticks(K)], "unreachable", "implementer"],
    ["leader not running for K - 1 ticks: not yet", ["start", "implementer not running", ...ticks(K - 1)], "progressing", null],
    ["a round typed in between starts the count over", ["start", "implementer not running", ...ticks(K - 1), "implementer free", "tick", "implementer not running", ...ticks(K - 1)], "progressing", null],
    ["unreachable, then the pane is back: the window says so before any tick", ["start", "implementer not running", ...ticks(K), "implementer free", "window"], "progressing", null],
    ["unreachable, then the pane is back and a tick types the round", ["start", "implementer not running", ...ticks(K), "implementer free", "tick"], "progressing", null],
    ["unreachable + restart: still unreachable (persisted)", ["start", "implementer not running", ...ticks(K), "restart"], "unreachable", "implementer"],
    ["unreachable + pause: paused", ["start", "implementer not running", ...ticks(K), "pause"], "paused", null],
    ["unreachable + pause + resume: a fresh count", ["start", "implementer not running", ...ticks(K), "pause", "resume"], "progressing", null],
    ["a busy leader is by design not unreachable", ["start", "implementer busy", ...ticks(K + 2)], "progressing", null],
    ["unreachable, then busy: working, so not unreachable", ["start", "implementer not running", ...ticks(K), "implementer free", "implementer busy", "tick"], "progressing", null],
    ["a leader on an approval screen is blocked, which wins", ["start", "implementer approval", "watch", ...ticks(K)], "blocked", null],
    ["a leader still starting up for K ticks is unreachable too", ["start", "implementer starting", ...ticks(K)], "unreachable", "implementer"],
    ["a stalled team whose leader then dies stays stalled (no round was held)", ["start", ...ticks(STALL + 1), "implementer not running", ...ticks(K)], "stalled", null],
    ["the leader's pane closed for K ticks", ["start", "implementer pane closed", ...ticks(K)], "unreachable", "implementer"],
    ["the leader's pane closed for K - 1 ticks: not yet", ["start", "implementer pane closed", ...ticks(K - 1)], "progressing", null],
    ["unreachable with no pane, then given a pane again: the window says so before any tick", ["start", "implementer pane closed", ...ticks(K), "implementer pane back", "window"], "progressing", null],
    ["unreachable (not running), then its pane is closed: still unreachable", ["start", "implementer not running", ...ticks(K), "implementer pane closed"], "unreachable", "implementer"],
    ["the leader's pane closed on a paused team: paused", ["start", "implementer pane closed", ...ticks(K), "pause"], "paused", null],
    ["the retries of one late round are one missed round, not several", ["start", "implementer not running", "a late relaunch", "tick", "retries", "retries"], "progressing", null],
  ];
  for (const [label, actions, status, role] of UNREACHED) {
    liveTest(`unreachable leader | ${label}`, async (t) => {
      await t.run(...actions);
      const live = await t.liveness();
      assert.equal(live.status, status);
      assert.equal(live.unreached?.role ?? null, role);
      if (role) assert.match(live.unreached.since, /^\d{4}-\d\d-\d\dT/);
    });
  }

  // A round that fell due while the app was closed is one missed round however often the app restarts
  // before the leader's pane takes it.
  const LATE = ["a late relaunch", "due tick"];
  const RESTARTED = ["restart", "due tick"];
  const RESTART_CELLS = [
    ["overdue round, leader unreachable, 3 restarts: one miss", ["start", "implementer not running", ...LATE, ...RESTARTED, ...RESTARTED, ...RESTARTED], "progressing", 1, []],
    ["overdue round, leader unreachable, 1 restart: one miss", ["start", "implementer not running", ...LATE, ...RESTARTED], "progressing", 1, []],
    ["overdue round, leader free, 3 restarts: typed once, the clock moved on", ["start", ...LATE, "restart", "restart", "restart"], "progressing", undefined, [1]],
    ["overdue round, leader unreachable, then 2 real rounds fall due: unreachable", ["start", "implementer not running", ...LATE, ...RESTARTED, "tick", "restart", "tick"], "unreachable", 3, []],
    ["round not due, leader unreachable, a restart before each of K ticks: K misses", ["start", "implementer not running", "restart", "tick", "restart", "tick", "restart", "tick"], "unreachable", 3, []],
    ["overdue round missed, leader back after the restarts: typed once", ["start", "implementer not running", ...LATE, ...RESTARTED, ...RESTARTED, "implementer free", "restart", "due tick"], "progressing", undefined, [1]],
  ];
  for (const [label, actions, status, misses, rounds] of RESTART_CELLS) {
    liveTest(`restart does not recount a missed round | ${label}`, async (t) => {
      await t.run(...actions);
      assert.equal((await t.liveness()).status, status);
      assert.equal((await t.store.progress()).unreached?.rounds, misses);
      assert.deepEqual(t.rounds(), rounds);
    });
  }

  // What is stored, not what the window derives (it hides a role whose pane is free again).
  liveTest("unreachable: a busy leader leaves no miss behind, and one miss before it is forgotten", async (t) => {
    await t.run("start", "implementer busy", ...ticks(K));
    assert.equal((await t.store.progress()).unreached, undefined);
    await t.run("user resolves", "implementer not running", "tick", "implementer free", "implementer busy", "tick");
    assert.equal((await t.store.progress()).unreached, undefined, "a busy agent ends the run of misses");
  });

  liveTest("unreachable: since is the first miss of the run, the count its length, the reason the latest", async (t) => {
    await t.run("start");
    const first = new Date(t.w.now + ROUND_MS).toISOString();
    await t.run("implementer draft", "tick", "implementer not running", "tick", "tick");
    const got = (await t.store.progress()).unreached;
    assert.deepEqual(got, { role: "implementer", reason: HOLD_NOT_RUNNING, since: first, rounds: 3, last: new Date(t.w.now).toISOString() });
    assert.deepEqual((await t.liveness()).unreached, { role: "implementer", reason: HOLD_NOT_RUNNING, since: first });
  });

  liveTest("unreachable: the window reports the pane's reason now, and a team that lost its cadence reports none", async (t) => {
    await t.run("start", "implementer not running", ...ticks(K), "implementer draft");
    assert.equal((await t.liveness()).unreached.reason, HOLD_DRAFT);
    const noCadence = await teamLiveness(t.store, ROLES, t.w.deps.holdReason, { cadence: null, lead: false }, t.w.now);
    assert.deepEqual([noCadence.status, noCadence.unreached], ["progressing", null]);
  });

  liveTest("unreachable: a round abandoned because the team was paused while it was prepared is not a miss", async (t) => {
    await t.run("start", "implementer not running", ...ticks(K - 1));
    t.w.holds["pane-i"] = null;
    const free = t.w.deps.holdReason;
    t.w.deps.holdReason = async (pane) => {
      if (pane === "pane-i" && t.w.pauseNow) {
        t.w.pauseNow = false;
        await t.w.runner.pause("game", "ux-review");
      }
      return free(pane);
    };
    t.w.pauseNow = true;
    await t.run("tick");
    assert.deepEqual(t.rounds(), [], "nothing was typed");
    assert.equal((await t.store.progress()).unreached.rounds, K - 1);
  });

  test("a stored miss of another shape is not a progress record", () => {
    const base = { seenMessageId: 0, commit: null, idleRounds: 0, awaiting: false, changedAt: "", stalledLogged: false, blocked: {} };
    const miss = { role: "implementer", reason: "x", since: "y", rounds: 3 };
    assert.ok(parseProgress({ ...base, unreached: miss }));
    assert.ok(parseProgress(base), "a record written before the field existed");
    for (const bad of [null, 5, [], { ...miss, rounds: "3" }, { ...miss, rounds: 1.5 }, { ...miss, role: 1 }, { ...miss, reason: null }, { ...miss, since: 2 }]) {
      assert.equal(parseProgress({ ...base, unreached: bad }), null, JSON.stringify(bad));
    }
    for (const blocked of [{ tester: "x" }, { tester: { reason: "x" } }, { tester: { reason: 1, since: "y" } }]) {
      assert.equal(parseProgress({ ...base, blocked }), null, JSON.stringify(blocked));
    }
    for (const unanswered of [null, { role: 1, rounds: 1 }, { role: "tester", rounds: "1" }]) {
      assert.equal(parseProgress({ ...base, unanswered }), null, JSON.stringify(unanswered));
    }
  });

  test("waiting for you follows the screen: transcript wording never, a real prompt yes, one free read clears it", async () => {
    const { openVtPane, closeVtPane, writeVtPane, paneHold } = await import("../dist-electron/vt-state.js");
    const t = await world();
    const RULE = "─".repeat(100);
    const free = ["⏺ I'm waiting for approval before starting titleCase.", RULE, "❯ \x1b[7m \x1b[27m", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"];
    const prompt = ["╭────────────────────────╮", "│ Do you want to proceed?│", "│ ❯ 1. Yes              │", "│   2. No               │", "╰────────────────────────╯"];
    const draw = async (pane, rows) => {
      writeVtPane(pane, "\x1b[2J\x1b[H" + rows.join("\r\n"));
      await new Promise((r) => setTimeout(r, 30));
    };
    const status = async () => {
      await t.run("watch");
      return (await teamLiveness(t.store, ROLES, paneHold, { cadence: 10, lead: true }, t.w.now)).status;
    };
    try {
      for (const pane of ["pane-t", "pane-i"]) openVtPane(pane, 120, 30, () => {}, "claude", false);
      await t.run("start");
      t.w.deps.holdReason = paneHold;
      await draw("pane-t", free);
      await draw("pane-i", free);
      assert.equal(await status(), "progressing");
      t.w.now += BLOCKED_AFTER_MS + 1_000;
      assert.equal(await status(), "progressing", "transcript wording above a free composer is never waiting for you");
      await draw("pane-t", prompt);
      assert.equal(await status(), "progressing", "a prompt is blocked only once it has stayed BLOCKED_AFTER_MS");
      t.w.now += BLOCKED_AFTER_MS + 1_000;
      assert.equal(await status(), "blocked");
      await draw("pane-t", free);
      assert.equal(await status(), "progressing", "one free read clears it");
    } finally {
      closeVtPane("pane-t");
      closeVtPane("pane-i");
      t.cleanup();
    }
  });

  test("unreachable leader | the leader's pane closed for K ticks -> the window's line says it has no pane", async () => {
    const { livenessLine } = await import("../dist-test/team-view.js");
    const t = await world();
    try {
      await t.run("start", "implementer pane closed", ...ticks(K));
      assert.match(livenessLine(await t.liveness()).text, /^no round typed to implementer since \d\d:\d\d: it has no pane$/);
    } finally {
      t.cleanup();
    }
  });

  async function bareStore(t) {
    const store = new TeamStore(mkdtempSync(join(tmpdir(), "aya-live-store-")));
    t.after(() => rmSync(store.dir, { recursive: true, force: true }));
    return store;
  }

  test("a Start or Resume on a HEAD the team had keeps it known once", async (t) => {
    const store = await bareStore(t);
    await resetProgress(store, "c1", "2026-10-02T10:00:00.000Z");
    await resetProgress(store, "c1", "2026-10-02T10:01:00.000Z");
    assert.deepEqual((await store.progress()).knownCommits, ["c1"]);
  });

  test("the team's last 200 HEADs stay known; the one before them is forgotten", async (t) => {
    assert.equal(KNOWN_COMMITS_KEPT, 200);
    const store = await bareStore(t);
    for (let i = 0; i <= KNOWN_COMMITS_KEPT; i += 1) await resetProgress(store, `c${i}`, "2026-10-02T10:00:00.000Z");
    const known = (await store.progress()).knownCommits;
    assert.equal(known.length, KNOWN_COMMITS_KEPT);
    assert.deepEqual([known[0], known.at(-1)], ["c1", `c${KNOWN_COMMITS_KEPT}`]);
  });

  test("talk seen late never moves the silence's clock back", async (t) => {
    const store = await bareStore(t);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await resetProgress(store, "c1", later);
    await store.append({ from: "tester", to: "implementer", text: "found two bugs", delivered: true, commit: null });
    await observe(store, "c1", {}, later);
    assert.equal((await store.progress()).changedAt, later);
  });

  test("a confirmed block the screen read free once is no longer shown as blocked", async (t) => {
    const store = await bareStore(t);
    await store.setPaused(false);
    await store.assign("tester", "pane-t");
    const nowMs = Date.parse("2026-10-02T11:00:00.000Z");
    const blocked = { tester: { reason: APPROVAL, since: "2026-10-02T10:00:00.000Z", freeReads: 1 } };
    await store.updateProgress(() => ({ ...FRESH_PROGRESS, changedAt: "2026-10-02T10:59:00.000Z", blocked }));
    const live = await teamLiveness(store, ROLES, async () => APPROVAL, { cadence: null, lead: true }, nowMs);
    assert.deepEqual(live.blocked, []);
  });

  test("a missed round one period after the last counted miss is another miss, not the same one", async (t) => {
    const store = await bareStore(t);
    const periodMs = 10 * ROUND_CHECK_MS;
    const t0 = Date.parse("2026-10-02T10:00:00.000Z");
    await noteRound(store, "tester", HOLD_DRAFT, new Date(t0).toISOString(), periodMs);
    await noteRound(store, "tester", HOLD_DRAFT, new Date(t0 + periodMs - ROUND_CHECK_MS / 4).toISOString(), periodMs);
    assert.equal((await store.progress()).unreached.rounds, 2);
  });

  test("a missed round counts again from half a check before its period: a millisecond earlier it is the same miss", async (t) => {
    assert.equal(ROUND_SLACK_MS, ROUND_CHECK_MS / 2);
    const store = await bareStore(t);
    const periodMs = 10 * ROUND_CHECK_MS;
    const t0 = Date.parse("2026-10-02T10:00:00.000Z");
    await noteRound(store, "tester", HOLD_DRAFT, new Date(t0).toISOString(), periodMs);
    await noteRound(store, "tester", HOLD_DRAFT, new Date(t0 + periodMs - ROUND_SLACK_MS - 1).toISOString(), periodMs);
    assert.equal((await store.progress()).unreached.rounds, 1, "a millisecond inside the slack: the same miss");
    await noteRound(store, "tester", HOLD_DRAFT, new Date(t0 + periodMs - ROUND_SLACK_MS).toISOString(), periodMs);
    assert.equal((await store.progress()).unreached.rounds, 2, "at the slack: another miss");
  });
});
