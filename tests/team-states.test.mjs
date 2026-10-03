// Every team state x receiving-pane state x action, outcome spelled out: a bug hid in
// one combination (running team + restart + old held rounds) each single-state test passed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { NO_PANE_HOLD, HOLD_APPROVAL, HOLD_APPROVE_AYA, HOLD_DRAFT, HOLD_NOT_RUNNING, HOLD_SHELL, HOLD_STARTING } = await import("../dist-electron/pane-holds.js");
const { parseTeamFile } = await import("../dist-electron/team-definition.js");
const { assignRole, listTeams, saveTeam, whileTeamNotSaved } = await import("../dist-electron/team-admin.js");
const { whileProjectPanesFree } = await import("../dist-electron/team-panes.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
implementer

## Cadence
implementer every 30 min
`;

// The implementer is the receiver in every case; the tester's pane is free. Team code passes most holds on as
// strings, so in the action matrix below the approval prompt stands for them.
const PANE_STATES = {
  free: null,
  "no pane": NO_PANE_HOLD,
  "not running": HOLD_NOT_RUNNING,
  "starting up": HOLD_STARTING,
  "approval prompt": HOLD_APPROVAL,
  "approval of an aya command": HOLD_APPROVE_AYA,
  "user typing": HOLD_DRAFT,
  shell: HOLD_SHELL,
};
const TEAM_STATES = ["never started", "running", "paused"];

/** What an earlier session left in state.json: its last round was `round`. */
function seedLastRound(store, round) {
  const file = join(store.dir, "state.json");
  let state = {};
  try {
    state = JSON.parse(readFileSync(file, "utf-8"));
  } catch {}
  writeFileSync(file, JSON.stringify({ ...state, lastRound: round }));
}

async function world(teamState, paneState) {
  const { teamHome, project, cleanup } = teamProject("aya-states-", { teamFile: TEAM });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  if (paneState !== "no pane") await store.assign("implementer", "pane-i");
  if (teamState === "running") await store.setPaused(false);
  if (teamState === "paused") await store.setPaused(true);
  const w = { paneState, now: Date.now() };
  const typed = [];
  const scheduled = [];
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async (pane) => (pane === "pane-i" ? PANE_STATES[w.paneState] : null),
    headCommit: async () => null,
  };
  const schedule = (fn, ms) => {
    const job = { fn, ms, cancelled: false };
    scheduled.push(job);
    return () => (job.cancelled = true);
  };
  // A relaunch: a new runner over the same files; the old one's timers are gone.
  const restart = async () => {
    scheduled.length = 0;
    w.runner = new TeamRunner(deps, schedule, () => w.now);
    await w.runner.restore();
  };
  const toImplementer = () => typed.filter((t) => t.pane === "pane-i");
  // As the window shows it: delivery state lives in read marks and notes beside the append-only log.
  const lastLog = async () => (await store.annotatedLog()).at(-1);
  const removeRepoFile = () => rmSync(join(project.directory, ".aya", "teams", "ux-review.md"));
  return Object.assign(w, { store, deps, removeRepoFile, runner: new TeamRunner(deps, schedule, () => w.now), restart, typed, scheduled, toImplementer, lastLog, cleanup });
}

const inWorld = (make) => (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const w = await make(...args);
    try {
      await fn(w);
    } finally {
      w.cleanup();
    }
  });
};
const worldTest = inWorld(world);
const reason = (paneState) => PANE_STATES[paneState];
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const texts = (w) => w.toImplementer().map((x) => x.text.replace(/^.*\] /, ""));
const { TEAM_MINUTE_MS } = await import("../dist-electron/paths.js");
// A look types a round only when one is due, so the fake clock moves first.
const MIN_MS = TEAM_MINUTE_MS;
const CADENCE_MS = 30 * MIN_MS;
const look = (w, ms = 0) => ((w.now += ms), w.scheduled.at(-1).fn());
const beat = (w) => look(w, CADENCE_MS);
const roundsTo = (w) => w.toImplementer().filter((t) => /Round \d+:/.test(t.text));

// The cells each action can tell apart: a team state only where the action reads it, the draft only
// where its note is written (typeMessage).
const ALL = ["free", "no pane", "approval prompt", "user typing"];
const SOME = ["free", "no pane", "approval prompt"];
const CELLS = {
  send: { "never started": ALL, running: ALL, paused: ["free"] },
  introduce: { "never started": ["free"], running: ALL, paused: ["free"] },
  start: { "never started": SOME, running: ["free"], paused: SOME },
  restore: { "never started": ["free"], running: ALL, paused: ["free"] },
  redelivery: { "never started": SOME, running: SOME, paused: ["free"] },
};
const cell = (action, teamState, paneState) => (CELLS[action][teamState].includes(paneState) ? (name, fn) => worldTest(name, teamState, paneState, fn) : () => {});

for (const teamState of TEAM_STATES) {
  for (const paneState of Object.keys(PANE_STATES)) {
    const label = `${teamState} team, receiver ${paneState}`;

    cell("send", teamState, paneState)(`aya team send | ${label}`, async (w) => {
      const send = handleTeamRequest({ type: "team-send", role: "implementer", text: "report 1" }, "pane-t", w.deps);
      if (teamState === "paused") {
        await assert.rejects(send, /paused; nothing was sent/);
        assert.equal((await w.store.log()).length, 0, "a paused team logs nothing");
      } else if (paneState === "free") {
        assert.match((await send).output, /written to implementer's pane/);
        assert.equal(w.toImplementer().length, 1);
        assert.equal((await w.lastLog()).delivered, true);
      } else {
        await assert.rejects(send, new RegExp(`implementer: ${escaped(reason(paneState))}; nothing was typed`));
        assert.equal(w.toImplementer().length, 0, "never typed into a held pane");
        assert.deepEqual([(await w.lastLog()).delivered, (await w.lastLog()).held], [false, reason(paneState)]);
      }
    });

    cell("introduce", teamState, paneState)(`assign (introduce) | ${label}`, async (w) => {
      const why = await w.runner.introduce("game", "ux-review", "implementer");
      if (teamState !== "running") {
        assert.equal(why, null);
        assert.equal(w.typed.length, 0, "only a running team introduces; otherwise Start does");
      } else if (paneState === "free") {
        assert.equal(why, null);
        assert.match(w.toImplementer()[0].text, /Delivery test/);
      } else {
        assert.equal(why, reason(paneState));
        assert.equal(w.typed.length, 0);
      }
    });

    cell("start", teamState, paneState)(`Start | ${label}`, async (w) => {
      const before = await w.store.state();
      const result = await w.runner.start("game", "ux-review");
      if (teamState === "running") {
        assert.deepEqual([result.started, result.alreadyRunning, w.typed.length], [false, true, 0], "a running team is not started again, whatever its panes show");
        assert.deepEqual(await w.store.state(), before, "and its state does not change");
        return;
      }
      if (paneState === "free") {
        assert.deepEqual([result.started, result.delivered.sort()], [true, ["implementer", "tester"]]);
        assert.deepEqual(await w.store.state(), { paused: false, running: true });
        assert.equal(w.scheduled.length, 1, "rounds armed");
      } else {
        assert.deepEqual(result, { started: false, delivered: [], held: [{ role: "implementer", reason: reason(paneState) }], task: null });
        assert.equal(w.typed.length, 0, "one pane not ready: nothing is sent to anyone");
        assert.equal((await w.store.log()).length, 0);
        assert.deepEqual(await w.store.state(), before, "the team state does not change");
        assert.equal(w.scheduled.length, 0);
      }
    });

    cell("restore", teamState, paneState)(`restore after a restart, then a round | ${label}`, async (w) => {
      seedLastRound(w.store, 4);
      await w.runner.restore();
      if (teamState !== "running") {
        assert.equal(w.scheduled.length, 0, "only a running team gets its rounds back");
        return;
      }
      assert.equal(w.scheduled.length, 1);
      await beat(w);
      if (paneState === "free") {
        assert.match(w.toImplementer()[0].text, /Round 5:/, "numbering goes on from the last session");
      } else {
        assert.equal(w.typed.length, 0, "a held pane skips the round");
        assert.deepEqual([(await w.lastLog()).from, (await w.lastLog()).text], ["aya", `round 5 skipped: ${reason(paneState)}`]);
        w.paneState = "free";
        if (paneState === "no pane") await w.store.assign("implementer", "pane-i");
        await look(w);
        assert.match(w.toImplementer()[0].text, /Round 5:/, "a skipped round keeps its number");
      }
    });

    cell("redelivery", teamState, paneState)(`redelivery of held messages | ${label}`, async (w) => {
      // What an earlier session left: a stale round and delivery test, and a peer report.
      await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Round 1: old", delivered: false, held: "shows an approval prompt" });
      await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Delivery test: old", delivered: false, held: "no pane assigned" });
      await w.store.append({ from: "tester", to: "implementer", commit: null, text: "peer report", delivered: false, held: "shows an approval prompt" });
      const typed = await w.runner.redeliverWaiting();
      if (teamState !== "paused" && paneState === "free") {
        assert.equal(typed, 1);
        assert.deepEqual(texts(w), ["peer report"], "Aya's own old messages never go out");
      } else {
        assert.equal(typed, 0);
        assert.equal(w.typed.length, 0);
      }
    });
  }
}

worldTest("pause stops rounds and sends; resume brings rounds back without resending delivery tests", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  w.typed.length = 0;
  await w.runner.pause("game", "ux-review");
  assert.deepEqual(await w.store.state(), { paused: true, running: false });
  await w.scheduled[0].fn();
  assert.equal(w.typed.length, 0, "a paused team's round does nothing");
  await w.runner.resume("game", "ux-review");
  assert.deepEqual(await w.store.state(), { paused: false, running: true });
  assert.equal(w.typed.length, 0, "resume sends no delivery tests");
  await beat(w);
  assert.equal(w.toImplementer().length, 1);
});

// Round numbers across actions: only Aya's own count is kept, so a restart,
// Resume or Start after Pause goes on from the last round typed.
const ROUND_ACTIONS = {
  start: (w) => w.runner.start("game", "ux-review"),
  pause: (w) => w.runner.pause("game", "ux-review"),
  resume: (w) => w.runner.resume("game", "ux-review"),
  restart: (w) => w.restart(),
  round: (w) => beat(w),
  // Every look sees a new HEAD, so an hour of rounds is no stall.
  "repo moves": (w) => {
    let commits = 0;
    w.deps.headCommit = async () => `c${++commits}`;
  },
  "held round": async (w) => {
    w.paneState = "approval prompt";
    await beat(w);
    w.paneState = "free";
  },
};
const ROUND_CASES = [
  [["start", "round", "round"], [1, 2]],
  [["start", "round", "restart", "round"], [1, 2]],
  [["start", "repo moves", "round", "round", "restart", "restart", "round"], [1, 2, 3]],
  [["start", "round", "pause", "resume", "round"], [1, 2]],
  [["start", "round", "pause", "start", "round"], [1, 2]],
  [["start", "round", "pause", "restart", "resume", "round"], [1, 2]],
  [["start", "round", "pause", "restart", "start", "round"], [1, 2]],
  [["start", "round", "restart", "pause", "resume", "restart", "round"], [1, 2]],
  [["start", "held round", "restart", "round"], [1]],
  [["start", "round", "held round", "restart", "round"], [1, 2]],
];

for (const [actions, rounds] of ROUND_CASES) {
  worldTest(`round numbers | ${actions.join(" > ")}`, "never started", "free", async (w) => {
    for (const action of actions) await ROUND_ACTIONS[action](w);
    const typed = w.toImplementer().flatMap((t) => t.text.match(/Round (\d+):/)?.[1] ?? []);
    assert.deepEqual(typed.map(Number), rounds);
  });
}

worldTest("a state.json from before round numbers were kept starts at Round 1", "never started", "free", async (w) => {
  writeFileSync(join(w.store.dir, "state.json"), JSON.stringify({ paused: false, started: true }));
  await w.restart();
  await beat(w);
  assert.match(w.toImplementer()[0].text, /^.*Round 1:/);
  const { roundClockAt, silenceRoundAt: _, ...rest } = JSON.parse(readFileSync(join(w.store.dir, "state.json"), "utf-8"));
  assert.deepEqual(rest, { paused: false, started: true, lastRound: 1 });
  assert.equal(typeof roundClockAt, "number", "the tick starts the clock");
});

// After a quit the pty host survives, so a pane reattaches as it was (a prompt or a draft is still there);
// after a host reap every agent respawns, so a pane is still starting or has drawn its composer.
const INBOX = {
  empty: async () => {},
  "Aya-only stale": async (w) => {
    await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Round 3: old", delivered: false, held: "shows an approval prompt" });
    await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Delivery test: old", delivered: false, held: "no pane assigned" });
  },
  "peer held": async (w) => {
    await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Round 3: old", delivered: false, held: "shows an approval prompt" });
    await w.store.append({ from: "tester", to: "implementer", commit: null, text: "peer report", delivered: false, held: "shows an approval prompt" });
  },
};
const PANE_AFTER = {
  "quit + relaunch": { "agent idle": "free", "approval prompt still up": "approval prompt", "draft still in the composer": "user typing" },
  "host reap": { "composer drawn": "free", "still starting": "starting up" },
};

for (const teamState of ["running", "paused"]) {
  for (const [event, panes] of Object.entries(PANE_AFTER)) {
    for (const inbox of Object.keys(INBOX)) {
      for (const [pane, paneState] of Object.entries(panes)) {
        const free = paneState === "free";
        worldTest(`${event} | ${teamState} team, inbox ${inbox}, pane ${pane}`, teamState, paneState, async (w) => {
          seedLastRound(w.store, 3);
          await INBOX[inbox](w);
          const assignments = await w.store.assignments();
          await w.restart();
          assert.deepEqual(await w.store.assignments(), assignments, "the roles keep their panes");
          assert.equal(w.scheduled.length, teamState === "running" ? 1 : 0, "only a running team gets its rounds back");

          const peer = inbox === "peer held" && teamState === "running" && free;
          assert.equal(await w.runner.redeliverWaiting(), peer ? 1 : 0);
          assert.deepEqual(texts(w), peer ? ["peer report"] : [], "the peer's report goes out, Aya's stale messages never do");
          assert.equal(await w.runner.redeliverWaiting(), 0, "a delivered message is typed once");

          if (teamState === "running") {
            await beat(w);
            const round = texts(w).filter((t) => /^Round \d+:/.test(t));
            assert.deepEqual(round.map((t) => t.slice(0, 8)), free ? ["Round 4:"] : [], "numbering goes on from the last session");
          }

          w.paneState = "free";
          const late = await w.runner.redeliverWaiting();
          const owed = inbox === "peer held" && teamState === "running" && !free;
          assert.equal(late, owed ? 1 : 0, "a message held for a busy pane goes out once it is free");
          if (teamState === "running" && !free) {
            await look(w);
            assert.equal(texts(w).filter((t) => /^Round 4:/.test(t)).length, 1, "the skipped round keeps its number");
          }
        });
      }
    }
  }

  for (const pane of ["not running", "starting up"]) {
    for (const inbox of Object.keys(INBOX)) {
      worldTest(`request before ready | ${teamState} team, inbox ${inbox}, tester's pane up, implementer ${pane}`, teamState, pane, async (w) => {
        await INBOX[inbox](w);
        const who = await handleTeamRequest({ type: "team-whoami" }, "pane-t", w.deps);
        assert.match(who.output, /team +ux-review\nyou +tester/, "whoami is answered from the saved team");
        const logged = (await w.store.log()).length;
        const send = handleTeamRequest({ type: "team-send", role: "implementer", text: "early" }, "pane-t", w.deps);
        if (teamState === "paused") {
          await assert.rejects(send, /paused; nothing was sent/);
          assert.equal((await w.store.log()).length, logged);
          return;
        }
        await assert.rejects(send, new RegExp(`implementer: ${escaped(reason(pane))}; nothing was typed, message \\d+ is kept`));
        assert.equal(w.typed.length, 0);
        w.paneState = "free";
        assert.equal(await w.runner.redeliverWaiting(), 1);
        // One message per pane per pass: an older peer report goes first, then the refused one.
        assert.equal(await w.runner.redeliverWaiting(), inbox === "peer held" ? 1 : 0);
        assert.deepEqual(texts(w), inbox === "peer held" ? ["peer report", "early"] : ["early"], "the refused message waits and goes out once");
        assert.equal(await w.runner.redeliverWaiting(), 0);
      });
    }
  }
}

// The repo file can vanish between quit and relaunch (a checkout, a pull); the saved copy still runs.
for (const teamState of ["running", "paused"]) {
  for (const inbox of ["empty", "peer held"]) {
    worldTest(`team file gone from the repo while quit | ${teamState} team, inbox ${inbox}`, teamState, "free", async (w) => {
      seedLastRound(w.store, 3);
      await INBOX[inbox](w);
      w.removeRepoFile();
      await w.restart();
      assert.equal(w.scheduled.length, teamState === "running" ? 1 : 0, "rounds come back from the saved copy");
      const who = await handleTeamRequest({ type: "team-whoami" }, "pane-t", w.deps);
      assert.match(who.output, /team +ux-review\nyou +tester/, "whoami is not told the pane has no role");
      const peer = inbox === "peer held" && teamState === "running";
      assert.equal(await w.runner.redeliverWaiting(), peer ? 1 : 0);
      assert.deepEqual(texts(w), peer ? ["peer report"] : []);
      if (teamState === "running") {
        await beat(w);
        assert.match(w.toImplementer().at(-1).text, /Round 4:/);
      }
    });
  }
}

// A relaunch must not push the next round a full cadence away, or an Aya that restarts more often than
// the cadence never runs a round. [name, time from Start to the relaunch, round due after the relaunch]
const CLOCK_CASES = [
  ["relaunch 20 min after the last round", 20 * MIN_MS, 10 * MIN_MS],
  ["relaunch 1 min after the last round", MIN_MS, 29 * MIN_MS],
  ["relaunch at exactly the cadence", 30 * MIN_MS, 0],
  ["relaunch long after the cadence", 3 * 60 * MIN_MS, 0],
  ["relaunch with the clock behind the last round", -5 * MIN_MS, CADENCE_MS],
];

for (const [name, elapsed, dueIn] of CLOCK_CASES) {
  worldTest(`round clock | ${name}`, "never started", "free", async (w) => {
    await w.runner.start("game", "ux-review");
    w.now += elapsed;
    await w.restart();
    if (dueIn > 0) {
      await look(w, dueIn - 1);
      assert.equal(roundsTo(w).length, 0, "not before");
    }
    await look(w, dueIn > 0 ? 1 : 0);
    assert.equal(roundsTo(w).length, 1, "at the due time");
  });
}

worldTest("round clock | a relaunch every 10 min under a 30 min cadence still fires a round", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  w.typed.length = 0;
  const fired = [];
  for (let life = 0; life < 4; life++) {
    w.now += 10 * MIN_MS;
    await w.restart();
    const before = roundsTo(w).length;
    await look(w);
    if (roundsTo(w).length > before) fired.push(life);
  }
  assert.deepEqual(fired, [2], "the third relaunch is 30 min after Start, so its round is due at once");
  assert.match(w.toImplementer().at(-1).text, /Round 1:/);
});

worldTest("round clock | a typed round moves the base", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  await beat(w);
  await w.restart();
  await look(w, CADENCE_MS - 1);
  assert.equal(roundsTo(w).length, 1, "a full cadence after the typed round, not after Start");
  await look(w, 1);
  assert.equal(roundsTo(w).length, 2);
});

worldTest("round clock | a held round keeps the base, so the round stays due", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  w.paneState = "approval prompt";
  await beat(w);
  await w.restart();
  w.paneState = "free";
  await look(w);
  assert.equal(roundsTo(w).length, 1);
});

worldTest("round clock | Resume and Start begin a full wait, whatever an older session left", "running", "free", async (w) => {
  writeFileSync(join(w.store.dir, "state.json"), JSON.stringify({ paused: true, started: true, roundClockAt: w.now - 5 * CADENCE_MS }));
  await w.runner.resume("game", "ux-review");
  await look(w, CADENCE_MS - 1);
  assert.equal(roundsTo(w).length, 0);
  await look(w, 1);
  assert.equal(roundsTo(w).length, 1);
});

worldTest("round clock | a state.json without a clock waits a full cadence", "running", "free", async (w) => {
  await w.restart();
  await look(w, CADENCE_MS - 1);
  assert.equal(roundsTo(w).length, 0);
  await look(w, 1);
  assert.equal(roundsTo(w).length, 1);
});

// A round due at relaunch is looked at before the panes respawn: it stays owed until a look finds the pane free.
const dueRelaunch = async (w) => {
  await w.runner.start("game", "ux-review");
  w.now += 2 * CADENCE_MS;
  w.paneState = "approval prompt";
  await w.restart();
};
const skipsOf = async (w) => (await w.store.log()).filter((m) => /^round \d+ skipped: /.test(m.text)).map((m) => m.text);

worldTest("held first round | typed at the first look that finds the pane free, then not again", "never started", "free", async (w) => {
  await dueRelaunch(w);
  await look(w);
  w.paneState = "free";
  await look(w, MIN_MS);
  assert.match(w.toImplementer().at(-1).text, /Round 1:/);
  await look(w, MIN_MS);
  assert.equal(roundsTo(w).length, 1, "a typed round is not typed again");
});

worldTest("held first round | a pane held for good is never typed into, over five relaunches; each round's skip is logged once", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  w.paneState = "approval prompt";
  for (let launch = 0; launch < 5; launch++) {
    w.now += 2 * CADENCE_MS;
    await w.restart();
    for (let i = 0; i < 10; i++) await look(w, MIN_MS);
  }
  assert.equal(roundsTo(w).length, 0);
  assert.deepEqual(await skipsOf(w), [`round 1 skipped: ${HOLD_APPROVAL}`]);
});

worldTest("held first round | a Pause stops the owed round", "never started", "free", async (w) => {
  await dueRelaunch(w);
  await look(w);
  await w.runner.pause("game", "ux-review");
  w.paneState = "free";
  await look(w, MIN_MS);
  assert.equal(roundsTo(w).length, 0);
});

worldTest("round clock | a Save of a running team keeps the clock, so repeated Saves never push a round back", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  for (let save = 0; save < 3; save++) {
    w.now += CADENCE_MS / 4;
    await w.runner.refresh("game", "ux-review");
  }
  await look(w, CADENCE_MS / 4);
  assert.equal(roundsTo(w).length, 1, "due 30 min after Start, three Saves later");
});

worldTest("a Save that lands before the boot-time restore has armed a running team arms it", "running", "free", async (w) => {
  await w.store.setRoundClockAt(w.now);
  w.scheduled.length = 0;
  await w.runner.refresh("game", "ux-review");
  assert.equal(w.scheduled.length, 1);
});

const REPO = { present: async () => {}, gone: async (w) => w.removeRepoFile() };
const REMOVE_CASES = [
  ["running", "present"],
  ["running", "gone"],
  ["stopped", "present"],
  ["stopped", "gone"],
];
for (const [teamState, repo] of REMOVE_CASES) {
  const setupTeam = async () => {
    const w = await world("never started", "free");
    if (teamState === "running") await w.runner.start("game", "ux-review");
    await REPO[repo](w);
    const other = new TeamStore(teamDir(w.deps.teamHome, "game", "other"));
    await other.saveDefinition(TEAM.replace("ux-review", "other"));
    await other.assign("tester", "pane-o");
    w.other = other;
    return w;
  };
  const summary = async (w) => (await listTeams(w.deps.teamHome, (await w.deps.listProjects())[0])).find((t) => t.name === "ux-review");
  const removeTest = inWorld(setupTeam);

  removeTest(`Remove | ${teamState} team, repo file ${repo}`, async (w) => {
    if (repo === "present") {
      await assert.rejects(w.runner.remove("game", "ux-review"), /still in the repo/);
      assert.deepEqual((await summary(w)).assignments, { tester: "pane-t", implementer: "pane-i" });
      assert.equal((await summary(w)).running, teamState === "running");
      assert.equal(w.scheduled.some((job) => !job.cancelled), teamState === "running", "the rounds go on");
      return;
    }
    await w.runner.remove("game", "ux-review");
    const names = (await listTeams(w.deps.teamHome, (await w.deps.listProjects())[0])).map((t) => t.name).filter((n) => n !== "other");
    assert.deepEqual(names, []);
    assert.equal(w.scheduled.every((job) => job.cancelled), true, "no round timer is left");
    assert.deepEqual(await w.other.assignments(), { tester: "pane-o" });
    assert.equal((await w.other.savedDefinition()) !== null, true);
    await w.restart();
    assert.equal(w.scheduled.length, 0, "a relaunch arms nothing for it");
  });

  removeTest(`Start and Pause | ${teamState} team, repo file ${repo}: the saved copy still works and the window says the file is gone`, async (w) => {
    const gone = repo === "gone";
    assert.deepEqual([(await summary(w)).repoGone, (await summary(w)).repoChanged], [gone, false]);
    if (teamState === "stopped") assert.equal((await w.runner.start("game", "ux-review")).started, true);
    await w.runner.pause("game", "ux-review");
    const paused = await summary(w);
    assert.deepEqual([paused.paused, paused.running, paused.repoGone], [true, false, gone]);
    await w.runner.resume("game", "ux-review");
    assert.equal((await summary(w)).running, true);
  });
}

const LOCKS = {
  "a save of the team file": (w, work) => whileTeamNotSaved(join(w.project.directory, ".aya", "teams", "ux-review.md"), work),
  "an assign or open of the project's panes": (w, work) => whileProjectPanesFree("game", work),
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 60));
for (const [label, lock] of Object.entries(LOCKS)) {
  for (const teamState of ["running", "stopped"]) {
    worldTest(`Remove | ${teamState} team, repo file gone, while ${label} is under way: Remove waits for it`, "never started", "free", async (w) => {
      if (teamState === "running") await w.runner.start("game", "ux-review");
      w.project = (await w.deps.listProjects())[0];
      w.removeRepoFile();
      const ended = [];
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const underWay = lock(w, async () => {
        await gate;
        ended.push("work");
      });
      const removal = w.runner.remove("game", "ux-review").then(() => ended.push("remove"), (err) => ended.push(`remove refused: ${err.message}`));
      await flush();
      const early = [...ended];
      release();
      await underWay;
      await removal;
      assert.deepEqual(early, [], "Remove did not run inside the other work");
      assert.equal(ended[0], "work");
    });
  }
}

worldTest("Remove | a save that wrote the repo file while Remove waited keeps the team: Remove is refused, nothing of the saved copy is lost", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  const project = (await w.deps.listProjects())[0];
  const file = join(project.directory, ".aya", "teams", "ux-review.md");
  w.removeRepoFile();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const save = whileTeamNotSaved(file, async () => {
    await gate;
    writeFileSync(file, TEAM);
  });
  const removal = w.runner.remove("game", "ux-review");
  removal.catch(() => {});
  await flush();
  release();
  await save;
  await assert.rejects(removal, /still in the repo/);
  const [team] = await listTeams(w.deps.teamHome, project);
  assert.deepEqual([team.unsaved, team.running, team.assignments], [false, true, { tester: "pane-t", implementer: "pane-i" }]);
  assert.equal(w.scheduled.filter((job) => !job.cancelled).length, 1, "the refused Remove leaves the rounds going");
});

worldTest("Remove | an assign that finished while Remove waited leaves no pane behind for a team of the same name", "never started", "free", async (w) => {
  const project = (await w.deps.listProjects())[0];
  w.removeRepoFile();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const assigning = whileProjectPanesFree("game", async () => {
    await gate;
    await assignRole(w.deps.teamHome, project, "ux-review", "tester", "pane-t");
  });
  const removal = w.runner.remove("game", "ux-review");
  await flush();
  release();
  await assigning;
  await removal;
  await saveTeam(w.deps.teamHome, project, parseTeamFile("ux-review", TEAM), { create: true });
  const [team] = await listTeams(w.deps.teamHome, project);
  assert.deepEqual(team.assignments, {});
});

worldTest("aya team new over a removed name starts clean, with none of the old rounds, panes or log", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  await beat(w);
  w.removeRepoFile();
  await w.runner.remove("game", "ux-review");
  const project = (await w.deps.listProjects())[0];
  const definition = parseTeamFile("ux-review", TEAM);
  await saveTeam(w.deps.teamHome, project, definition, { create: true });
  const [team] = (await listTeams(w.deps.teamHome, project)).filter((t) => t.name === "ux-review");
  assert.deepEqual([team.running, team.paused, team.assignments, team.log], [false, false, {}, []]);
  assert.equal(await new TeamStore(teamDir(w.deps.teamHome, "game", "ux-review")).lastRound(), 0);
});

const gateHold = (w, firstOnly = false) => {
  let gated = false;
  let open;
  let reach;
  const gate = new Promise((resolve) => (open = resolve));
  const reached = new Promise((resolve) => (reach = resolve));
  const held = w.deps.holdReason;
  w.deps.holdReason = async (pane) => {
    if (firstOnly && gated) return held(pane);
    gated = true;
    reach();
    await gate;
    return held(pane);
  };
  return Object.assign(open, { reached });
};
const REARMS = {
  refresh: [(w) => w.runner.refresh("game", "ux-review"), 1],
  resume: [(w) => w.runner.resume("game", "ux-review"), 1],
  Remove: [(w) => w.runner.remove("game", "ux-review"), 0],
};
for (const [action, [rearm, roundsTyped]] of Object.entries(REARMS)) {
  worldTest(`held first round | ${action} while a due tick is in flight: the freed pane gets ${roundsTyped} round(s)`, "never started", "free", async (w) => {
    await dueRelaunch(w);
    const release = gateHold(w);
    const inflight = look(w);
    if (action === "Remove") w.removeRepoFile();
    const rearmed = rearm(w);
    release();
    await inflight;
    await rearmed;
    w.paneState = "free";
    if (roundsTyped) await look(w, action === "resume" ? CADENCE_MS : 0);
    assert.equal(roundsTo(w).length, roundsTyped);
  });
}

worldTest("a Save while a due tick is typing on a free pane: the round is typed once, not by both ticks", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  w.now += 2 * CADENCE_MS;
  await w.restart();
  const release = gateHold(w, true);
  const first = look(w);
  await release.reached;
  await w.runner.refresh("game", "ux-review");
  const second = look(w);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(texts(w).filter((t) => /^Round/.test(t)).map((t) => t.slice(0, 8)), ["Round 1:"]);
  assert.equal(await w.store.lastRound(), 1);
});

const teamDirOf = (w) => teamDir(w.deps.teamHome, "game", "ux-review");
const createAgain = async (w) => {
  const project = (await w.deps.listProjects())[0];
  await saveTeam(w.deps.teamHome, project, parseTeamFile("ux-review", TEAM), { create: true });
  return new TeamStore(teamDirOf(w));
};

worldTest("Remove during a gated tick: Remove waits for it, no round is typed, and a same-name team starts clean", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  const release = gateHold(w);
  const inflight = beat(w);
  await release.reached;
  w.removeRepoFile();
  let removed = false;
  const removal = w.runner.remove("game", "ux-review").then(() => (removed = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const removedBeforeTheTick = removed;
  release();
  await Promise.all([inflight, removal]);
  assert.deepEqual([removedBeforeTheTick, roundsTo(w).length], [false, 0]);
  assert.equal(existsSync(teamDirOf(w)), false, "the late tick recreated nothing");
  const fresh = await createAgain(w);
  assert.deepEqual([await fresh.lastRound(), await fresh.log()], [0, []]);
});

worldTest("Remove during a redelivery: the late typing and read marks are dropped, and a same-name team starts clean", "running", "free", async (w) => {
  await w.store.append({ from: "tester", to: "implementer", commit: null, text: "report", delivered: false, held: "x" });
  const deliver = w.deps.deliver;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  w.deps.deliver = async (pane, text) => {
    await gate;
    return deliver(pane, text);
  };
  const pass = w.runner.redeliverWaiting();
  await new Promise((resolve) => setTimeout(resolve, 50));
  w.removeRepoFile();
  await w.runner.remove("game", "ux-review");
  release();
  await pass;
  assert.equal(existsSync(teamDirOf(w)), false, "the late marks recreated nothing");
  const fresh = await createAgain(w);
  assert.deepEqual([await fresh.readMarks(), await fresh.log()], [{}, []]);
});

const SEND = { type: "team-send", role: "implementer", text: "report 1" };
const removeTeam = (w) => new TeamStore(teamDirOf(w)).remove();

worldTest("aya team send | Remove before the text is typed: nothing is typed, and the sender is told nothing was sent", "running", "free", async (w) => {
  w.deps.holdReason = async () => {
    await removeTeam(w);
    return null;
  };
  await assert.rejects(handleTeamRequest(SEND, "pane-t", w.deps), /team was removed/);
  assert.equal(w.typed.length, 0);
  assert.equal(existsSync(teamDirOf(w)), false);
});

worldTest("aya team send | Remove while the text is being typed: the sender is told it was typed but not recorded", "running", "free", async (w) => {
  const deliver = w.deps.deliver;
  w.deps.deliver = async (pane, text) => {
    await deliver(pane, text);
    await removeTeam(w);
  };
  await assert.rejects(handleTeamRequest(SEND, "pane-t", w.deps), /implementer: typed into its pane, but not recorded \(team was removed/);
  assert.equal(w.toImplementer().length, 1);
  assert.equal(existsSync(teamDirOf(w)), false);
});

test("a Save that lands inside restore's arm wins: restore does not re-arm the older cadence", async () => {
  const w = await world("never started", "free");
  const original = TeamStore.prototype.roundClockAt;
  try {
    await w.runner.start("game", "ux-review");
    let saved = false;
    TeamStore.prototype.roundClockAt = async function (...args) {
      if (!saved) {
        saved = true;
        await this.saveDefinition(TEAM.replace("every 30 min", "every 10 min"));
        await w.runner.refresh("game", "ux-review");
      }
      return original.apply(this, args);
    };
    await w.restart();
    assert.equal(w.scheduled.filter((job) => !job.cancelled).length, 1);
    await look(w, 10 * MIN_MS);
    assert.equal(roundsTo(w).length, 1, "the Save's 10 min rhythm runs, not restore's 30 min");
  } finally {
    TeamStore.prototype.roundClockAt = original;
    w.cleanup();
  }
});

test("a Save that adds a cadence inside restore's read of a cadence-less team is not cancelled by restore", async () => {
  const w = await world("never started", "free");
  const original = TeamStore.prototype.savedDefinition;
  try {
    await w.runner.start("game", "ux-review");
    let landed = false;
    TeamStore.prototype.savedDefinition = async function (...args) {
      const text = await original.apply(this, args);
      if (landed) return text;
      landed = true;
      const withoutCadence = text.replace(/\n## Cadence[\s\S]*$/, "\n");
      await this.saveDefinition(text.replace("every 30 min", "every 10 min"));
      await w.runner.refresh("game", "ux-review");
      return withoutCadence;
    };
    await w.restart();
    assert.equal(w.scheduled.filter((job) => !job.cancelled).length, 1, "the Save's clock survives restore's older copy");
    await look(w, 10 * MIN_MS);
    assert.equal(roundsTo(w).length, 1);
  } finally {
    TeamStore.prototype.savedDefinition = original;
    w.cleanup();
  }
});

worldTest("held first round | a tick of an older arm types nothing, whether it starts after the re-arm or was opening the team when it landed", "never started", "free", async (w) => {
  await w.runner.start("game", "ux-review");
  const older = w.scheduled[0].fn;
  await w.runner.refresh("game", "ux-review");
  w.now += CADENCE_MS;
  await older();
  assert.equal(w.toImplementer().filter((t) => /Round/.test(t.text)).length, 0, "a tick started after the re-arm");

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const listProjects = w.deps.listProjects;
  let first = true;
  w.deps.listProjects = async () => {
    if (first) {
      first = false;
      await gate;
    }
    return listProjects();
  };
  const opening = w.scheduled.at(-1).fn();
  await w.runner.refresh("game", "ux-review");
  release();
  await opening;
  assert.equal(w.toImplementer().filter((t) => /Round/.test(t.text)).length, 0, "a tick opening the team when the re-arm landed");
});

// [command, config, measured reach]; the measurements are in docs/teams.md, "States a team depends on".
const { cantReach, launchMode, launchNoteOf } = await import("../dist-electron/launch-mode.js");
const { withLaunchHolds } = await import("../dist-electron/team-control.js");

const SOCK = "/h/.aya/aya.sock";
const SANDBOXED = JSON.stringify({ sandbox: { enabled: true } });
const ALLOW_SOCK = JSON.stringify({ sandbox: { network: { allowUnixSockets: [SOCK] } } });
const modeOf = (command, config) => launchMode(command, { codex: [], opencode: [], claude: [], socket: SOCK, ...config });
const LAUNCHES = {
  "codex, default sandbox workspace-write": ["codex --no-daemon", {}, "blocked"],
  "codex -s read-only": ["codex --no-daemon -s read-only", {}, "blocked"],
  "codex opened by team open (+ network)": ["codex -c sandbox_workspace_write.network_access=true --no-daemon", {}, "reaches"],
  "codex full access": ["codex --no-daemon --dangerously-bypass-approvals-and-sandbox", {}, "reaches"],
  "codex on the shared daemon": ["codex --dangerously-bypass-approvals-and-sandbox", {}, "blocked"],
  "opencode build agent": ["opencode", {}, "reaches"],
  "opencode plan agent": ["opencode --agent plan", {}, "blocked"],
  "claude, no sandbox": ["claude", {}, "reaches"],
  "claude, sandbox on": ["claude", { claude: [SANDBOXED] }, "blocked"],
  "claude opened by team open (socket allowed)": [`claude --settings '${ALLOW_SOCK}'`, { claude: [SANDBOXED] }, "reaches"],
  "grok, sandbox read-only": ["grok --sandbox read-only", {}, "reaches"],
  "a shell": ["$SHELL", {}, "unknown"],
  "codex, untrusted project config": ["codex --no-daemon", { codexProject: ['sandbox_mode = "danger-full-access"'], codexTrusted: false }, "unknown"],
  "codex, config Aya cannot read": ["codex --no-daemon", { codex: ["sandbox_mode = mode_var"] }, "unknown"],
  "claude in plan mode": ["claude --permission-mode plan", {}, "unknown"],
  "claude, unreadable settings": ["claude", { claude: ["{not json"] }, "unknown"],
  "codex exec (not a session)": ["codex exec hi", {}, "unknown"],
  "wrapped codex: cd sub && env codex": ["cd sub && env codex", {}, "unknown"],
  "cd lead: cd sub && codex, default sandbox": ["cd sub && codex --no-daemon", {}, "blocked"],
  "cd lead: cd sub && codex opened by team open (+ network)": ["cd sub && codex -c sandbox_workspace_write.network_access=true --no-daemon", {}, "reaches"],
  "cd lead: cd ~/web && claude": ["cd ~/web && claude", {}, "reaches"],
  "cd lead: cd sub && claude, sandbox on": ["cd sub && claude", { claude: [SANDBOXED] }, "blocked"],
  "cd lead: cd 'a b' && opencode --agent plan": ["cd 'a b' && opencode --agent plan", {}, "blocked"],
  // Reaches once approved, so not held; the note says each aya call waits for you.
  "codex full access, approval untrusted": ["codex --no-daemon -s danger-full-access -a untrusted", {}, "reaches"],
  "wrapped codex: npx codex": ["npx codex", {}, "unknown"],
  "wrapped codex: env codex": ["env codex", {}, "unknown"],
  "wrapped codex: sh -c": ["sh -c 'codex'", {}, "unknown"],
  "wrapped codex: cd a; codex": ["cd a; codex", {}, "unknown"],
  "wrapped claude: cd ~/proj && npx claude": ["cd ~/proj && npx claude", {}, "unknown"],
  "wrapped command that is no agent": ["cd sub && make test", {}, "unknown"],
  "aider": ["aider", {}, "unknown"],
};

/** The implementer's pane runs `command`; its hold is the host's, else its launch's. */
const launchTest = inWorld(launchWorld);
async function launchWorld(teamState, command, config) {
  const w = await world(teamState, "free");
  const mode = modeOf(command, config);
  w.deps.holdReason = withLaunchHolds(async () => null, async (pane) => (pane === "pane-i" ? cantReach(mode) : null));
  w.runner = new TeamRunner(w.deps, () => () => {});
  return Object.assign(w, { mode, block: cantReach(mode), note: launchNoteOf({ command, cwd: "/p", mode }) });
}

// The team sees a launch only as cantReach's string and launchNoteOf's note: one launch per reach stands for the rest.
const TEAM_CELLS = new Set(["codex, default sandbox workspace-write", "claude, no sandbox", "wrapped codex: npx codex"]);

for (const [label, [command, config, reach]] of Object.entries(LAUNCHES)) {
  const held = reach === "blocked";
  const HELD_TEXT = /^can't reach Aya: /;
  test(`launch mode is measured | ${label} -> ${reach}`, () => {
    const mode = modeOf(command, config);
    assert.equal(mode.reach, reach);
    assert.equal(cantReach(mode) !== null, held, "held exactly when measured blocked; unknown is never held");
  });
  if (!TEAM_CELLS.has(label)) continue;

  for (const teamState of TEAM_STATES) {
    const cell = `${teamState} team, receiver ${label}`;

    launchTest(`Start preflight | ${cell}`, teamState, command, config, async (w) => {
      const result = await w.runner.start("game", "ux-review");
      if (teamState === "running") {
        assert.deepEqual([result.started, result.alreadyRunning, w.typed.length], [false, true, 0], "a running team is not started again, whatever its panes show");
        return;
      }
      if (held) {
        assert.deepEqual([result.started, result.held], [false, [{ role: "implementer", reason: w.block }]]);
        assert.match(w.block, HELD_TEXT);
        assert.equal(w.typed.length, 0, "nothing is typed into any pane");
      } else {
        assert.deepEqual([result.started, result.delivered.sort()], [true, ["implementer", "tester"]]);
      }
    });

    launchTest(`assign (introduce) | ${cell}`, teamState, command, config, async (w) => {
      const why = await w.runner.introduce("game", "ux-review", "implementer");
      if (teamState !== "running") assert.equal(why, null, "only a running team introduces");
      else if (held) assert.equal(why, w.block);
      else assert.match(w.toImplementer()[0].text, /Delivery test/);
      if (held) assert.equal(w.typed.length, 0);
    });

    launchTest(`aya team send to it | ${cell}`, teamState, command, config, async (w) => {
      const send = handleTeamRequest({ type: "team-send", role: "implementer", text: "report 1" }, "pane-t", w.deps);
      if (teamState === "paused") await assert.rejects(send, /paused/);
      else if (held) {
        await assert.rejects(send, /implementer: can't reach Aya: .*; nothing was typed, message \d+ is kept for aya team inbox/);
        assert.equal(w.typed.length, 0);
      } else assert.match((await send).output, /written to implementer's pane/);
    });

    launchTest(`the Teams window's role status | ${cell}`, teamState, command, config, async (w) => {
      const [team] = await listTeams(w.deps.teamHome, (await w.deps.listProjects())[0], w.deps.holdReason, undefined, async (pane) => (pane === "pane-i" ? w.note : null));
      assert.equal(team.paneHolds.implementer, held ? w.block : null);
      if (reach === "unknown") assert.match(team.paneNotes.implementer, /^may not reach Aya: /, "the window says so, as a note");
    });
  }

  // A blocked launch mode's request never arrives (connect EPERM in the CLI); Aya answers every one that does.
  launchTest(`aya team whoami | ${label}`, "running", command, config, async (w) => {
    assert.match((await handleTeamRequest({ type: "team-whoami" }, "pane-i", w.deps)).output, /^team +ux-review\nyou +implementer\n/);
    assert.equal(w.block === null, !held);
  });
}

// Measured: the second Codex pane on one daemon printed the first pane's AYA_TERMINAL_ID.
const SHARED_DAEMON = "codex --dangerously-bypass-approvals-and-sandbox";
worldTest("same project, two Codex panes on the shared daemon: neither is typed into, Start names both", "never started", "free", async (w) => {
  const launched = { "pane-t": SHARED_DAEMON, "pane-i": SHARED_DAEMON };
  const holdOf = (pane) => cantReach(modeOf(launched[pane]));
  w.deps.holdReason = withLaunchHolds(async () => null, async (pane) => holdOf(pane));
  const runner = new TeamRunner(w.deps, () => () => {});
  const result = await runner.start("game", "ux-review");
  assert.equal(result.started, false);
  assert.deepEqual(result.held, [
    { role: "tester", reason: holdOf("pane-t") },
    { role: "implementer", reason: holdOf("pane-i") },
  ]);
  assert.match(holdOf("pane-t"), /shared daemon.*speak as another Codex pane/);
  const borrowed = await handleTeamRequest({ type: "team-whoami" }, "pane-t", w.deps);
  assert.match(borrowed.output, /you +tester/);
  assert.equal(w.typed.length, 0);
});
