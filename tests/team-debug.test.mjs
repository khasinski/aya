// With debug on every decision of a team goes to its debug.jsonl; off, nothing is formatted or written.
// One cadence "minute" lasts 3 s here.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-debug-home-"));
delete process.env.AYA_DEBUG;

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "./helpers/control-rpc.mjs";
import { teamProject } from "./helpers/team.mjs";
import { waitFor } from "./helpers/wait-for.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamLiveness } = await import("../dist-electron/team-progress.js");
const { handleTeamRequest, PaneHeldError } = await import("../dist-electron/team-control.js");
const { startControlServerOn, TURN_NOT_SEEN } = await import("../dist-electron/control.js");
const { reachedAyaPanes } = await import("../dist-electron/reached-aya.js");
const { recordAgentStatus } = await import("../dist-electron/agent-status.js");
const { HOLD_APPROVAL } = await import("../dist-electron/pane-holds.js");
const debug = await import("../dist-electron/team-debug.js");
const { SILENCE_FIRST_MS, SILENCE_REPEAT_MS } = await import("../dist-electron/team-times.js");

const HOME = process.env.AYA_HOME;
const S = 1000;
const BEAT = TEST_TEAM_MINUTE_MS / S; // seconds: "every 1 min"
const SILENCE = SILENCE_FIRST_MS / S;
const REPEAT = SILENCE_REPEAT_MS / S;
const stopWatch = debug.watchDebugSwitch(HOME);
process.on("exit", () => (stopWatch(), rmSync(HOME, { recursive: true, force: true })));

/** aya debug on|off: the file the CLI writes; the running process sees it with no restart. */
async function setDebug(on) {
  writeFileSync(join(HOME, "debug.json"), JSON.stringify({ on }));
  await waitFor(() => debug.debugOn() === on, 4000);
}

const TEAM = ({ cadence = true } = {}) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
tester
${cadence ? "\n## Cadence\ntester every 1 min\n" : ""}`;

async function world(opts = {}) {
  for (const pane of ["pane-t", "pane-i"]) recordAgentStatus(pane, "clear", 0);
  const t = teamProject("aya-debug-", { teamFile: TEAM(opts), tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { holds: {}, unseen: {}, onPaste: null, typed: [], jobs: [], commit: "c0", now: Date.parse("2026-10-02T10:00:00Z") };
  w.deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text, cancelled, entered, pasting) => {
      await pasting?.();
      await w.onPaste?.(pane);
      if (cancelled?.()) throw new PaneHeldError("the team was paused or changed while it was typed; text left in the composer, Enter not sent", true);
      w.typed.push({ pane, text });
      await entered?.();
      return w.unseen[pane] ?? null;
    },
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => w.commit,
    treeState: async () => "t0",
  };
  w.runner = new TeamRunner(w.deps, (fn) => (w.jobs.push(fn), () => {}), () => w.now, () => {});
  const look = async (seconds) => {
    w.now += seconds * S;
    await w.jobs.at(-1)?.();
  };
  const start = (task) => w.runner.start("game", "ux-review", task);
  const live = () => teamLiveness(store, ["tester", "implementer"], w.deps.holdReason, { cadence: opts.cadence === false ? null : 1, lead: true }, w.now);
  const events = () => {
    const file = join(store.dir, "debug.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { t, w, store, look, start, live, events, cleanup: () => (w.runner.stopAll(), t.cleanup()) };
}

const debugWorld = async (...args) => (await setDebug(true), world(...args));
const inWorld = (make) => (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const x = await make(...args);
    try {
      await fn(x);
    } finally {
      x.cleanup();
    }
  });
};
const debugTest = inWorld(debugWorld);
const worldTest = inWorld(world);

const has = (events, event, fields) =>
  events.some((e) => e.event === event && Object.entries(fields).every(([k, v]) => (v instanceof RegExp ? v.test(String(e[k])) : JSON.stringify(e[k]) === JSON.stringify(v))));

// [scenario, team options, what it does, [event, fields it carries]...]
const SCENARIOS = [
  ["Start with a task", {}, async (x) => void (await x.start({ text: "fix the login page" })), [
    ["start", { started: true, by: null }],
    ["turn", { to: "tester", from: "aya", seen: true }],
    ["owed", { role: "tester", from: "user", change: "added" }],
    ["reserve", { role: "tester", state: "queued" }],
    ["reserve", { role: "tester", state: "pasting" }],
    ["reserve", { role: "tester", state: "dropped" }],
    ["owed", { role: "tester", change: "done" }],
  ]],
  ["Start held by a pane", {}, async (x) => ((x.w.holds["pane-i"] = HOLD_APPROVAL), void (await x.start())), [
    ["start", { started: false, held: [{ role: "implementer", reason: HOLD_APPROVAL }] }],
  ]],
  ["a rhythm round", {}, async (x) => (await x.start(), await x.look(BEAT)), [
    ["round-check", { rhythm: true, silence: false, stall: false }],
    ["round", { round: 1, reason: "rhythm", typed: true }],
  ]],
  ["a silence round", { cadence: false }, async (x) => (await x.start(), await x.look(SILENCE + 1)), [
    ["round-check", { rhythm: false, silence: true, stall: false }],
    ["round", { round: 1, reason: "silence", typed: true }],
  ]],
  ["the brake", {}, async (x) => {
    await x.start();
    for (let i = 0; i < 4; i++) await x.look(BEAT);
  }, [
    ["round", { round: 3, typed: true }],
    ["round", { round: 4, held: "brake", unanswered: 3 }],
  ]],
  ["a stall", { cadence: false }, async (x) => {
    await x.start();
    for (const s of [SILENCE + 1, REPEAT, REPEAT, REPEAT, REPEAT]) await x.look(s);
  }, [
    ["round", { reason: "stall", typed: true }],
    ["round", { skipped: /^stalled: no change to the repo since/ }],
  ]],
  ["a lead busy: the round waits", {}, async (x) => {
    await x.start();
    x.w.holds["pane-t"] = HOLD_APPROVAL;
    await x.look(BEAT);
  }, [
    ["hold", { to: "tester", from: "aya", reason: HOLD_APPROVAL }],
    ["round", { round: 1, skipped: HOLD_APPROVAL }],
  ]],
  ["a Pause while the round is typed", {}, async (x) => {
    await x.start();
    x.w.onPaste = async () => x.w.runner.pause("game", "ux-review");
    await x.look(BEAT);
  }, [
    ["pause", { by: "user", token: 1 }],
    ["hold", { to: "tester", reason: /paused or changed while it was typed/, typed: true }],
  ]],
  ["a redelivery", {}, async (x) => {
    await x.start();
    x.w.holds["pane-i"] = HOLD_APPROVAL;
    await handleTeamRequest({ type: "team-send", role: "implementer", text: "the login button is gone" }, "pane-t", x.w.deps).catch(() => {});
    delete x.w.holds["pane-i"];
    await x.w.runner.redeliverWaiting();
  }, [
    ["owed", { role: "implementer", from: "tester", change: "added", text: "the login button is gone" }],
    ["hold", { to: "implementer", from: "tester", reason: HOLD_APPROVAL }],
    ["redelivery", { role: "implementer", hold: null }],
    ["owed", { role: "implementer", change: "done" }],
  ]],
  ["a crash left a reservation mid-paste", {}, async (x) => {
    await x.start();
    const m = await x.store.append({ from: "tester", to: "implementer", commit: null, text: "check this", delivered: false });
    writeFileSync(join(x.store.dir, "typing.json"), JSON.stringify({ implementer: m.id }));
    await handleTeamRequest({ type: "team-inbox" }, "pane-i", x.w.deps);
  }, [
    ["reserve", { role: "implementer", state: "folded", pasting: true }],
  ]],
  ["the turn proof: not seen", {}, async (x) => ((x.w.unseen["pane-t"] = TURN_NOT_SEEN), void (await x.start())), [
    ["turn", { to: "tester", seen: false, why: TURN_NOT_SEEN }],
  ]],
  ["liveness changes", { cadence: false }, async (x) => {
    await x.start();
    await x.live();
    await x.live();
    for (const s of [SILENCE + 1, REPEAT, REPEAT, REPEAT]) await x.look(s);
    await x.live();
  }, [
    ["liveness", { status: "progressing" }],
    ["liveness", { status: "stalled", why: /^no change to the repo since/ }],
  ]],
  ["liveness from the clock alone, the Teams window closed", { cadence: false }, async (x) => {
    await x.start();
    for (const s of [SILENCE + 1, REPEAT, REPEAT, REPEAT]) await x.look(s);
  }, [
    ["liveness", { status: "progressing" }],
    ["liveness", { status: "stalled" }],
  ]],
];

for (const [name, opts, run, expected] of SCENARIOS) {
  debugTest(`debug on | ${name}: ${expected.map(([e]) => e).join(", ")}`, opts, async (x) => {
    await run(x);
    const events = x.events();
    for (const [event, fields] of expected) assert.ok(has(events, event, fields), `${event} ${JSON.stringify(fields, (_k, v) => (v instanceof RegExp ? String(v) : v))} in:\n${events.map((e) => JSON.stringify(e)).join("\n")}`);
    for (const e of events) assert.match(e.time, /^\d{4}-\d\d-\d\dT/);
  });
}

debugTest("debug on | liveness is written when it changes, not at every look", { cadence: false }, async (x) => {
  await x.start();
  for (let i = 0; i < 3; i++) await x.live();
  assert.equal(x.events().filter((e) => e.event === "liveness").length, 1);
});

test("debug on | a socket answer to aya team: command, caller, result or refusal", async () => {
  const x = await debugWorld();
  const sock = join(mkdtempSync(join(tmpdir(), "aya-debug-sock-")), "aya.sock");
  const stop = startControlServerOn(sock, { getWindow: () => null, openProject: () => {}, listProjects: x.w.deps.listProjects, team: x.w.deps, teamRunner: x.w.runner });
  try {
    await x.start();
    assert.equal((await rpc(sock, { type: "team-whoami", caller: { terminalId: "pane-t" } })).ok, true);
    assert.equal((await rpc(sock, { type: "team-send", role: "nobody", text: "hi", caller: { terminalId: "pane-t" } })).ok, false);
    await rpc(sock, { type: "team-start", team: "ux-review", projectSlug: "game", caller: {} });
    const events = x.events();
    assert.ok(has(events, "socket", { command: "team-start", caller: null, ok: false }), JSON.stringify(events));
    assert.ok(has(events, "socket", { command: "team-whoami", caller: "pane-t", role: "tester", ok: true }), JSON.stringify(events));
    assert.ok(has(events, "socket", { command: "team-send", caller: "pane-t", to: "nobody", ok: false, error: /does not send to nobody/ }), JSON.stringify(events));
  } finally {
    stop();
    x.cleanup();
  }
});

debugTest("debug on | a pane's launch verdict settles: unknown -> reached, once", async (x) => {
  const table = new Map([[200, { ppid: 100, command: "aya" }], [100, { ppid: 1, command: "codex" }]]);
  const panes = reachedAyaPanes({ panePid: async (id) => (id === "pane-i" ? 100 : null), processTable: async () => table, onReached: (pane) => debug.debugPane(x.w.deps, pane, "launch", { verdict: "reached" }) });
  await panes.called({ terminalId: "pane-i", pid: 200 });
  await panes.called({ terminalId: "pane-i", pid: 200 });
  await waitFor(() => x.events().length > 0);
  const launches = x.events().filter((e) => e.event === "launch");
  assert.deepEqual(launches.map(({ pane, role, verdict }) => ({ pane, role, verdict })), [{ pane: "pane-i", role: "implementer", verdict: "reached" }]);
});

debugTest("debug on | a message's text is cut to 80 characters; no env or tokens are fields", async (x) => {
  await x.start();
  const long = `secret-start ${"x".repeat(200)}`;
  await handleTeamRequest({ type: "team-send", role: "implementer", text: long }, "pane-t", x.w.deps);
  const owed = x.events().find((e) => e.event === "owed" && e.change === "added");
  assert.equal(debug.MESSAGE_CHARS, 80);
  assert.equal(owed.text, `${long.slice(0, debug.MESSAGE_CHARS)}...`);
  assert.ok(!readFileSync(join(x.store.dir, "debug.jsonl"), "utf8").includes("x".repeat(debug.MESSAGE_CHARS + 1)));
});

test("debug off | a whole team run writes and formats nothing for debugging", async () => {
  await setDebug(false);
  const appends = mock.method(fs, "appendFileSync");
  const renames = mock.method(fs, "renameSync");
  const x = await world({ cadence: false });
  try {
    await x.start({ text: "go" });
    for (const s of [SILENCE + 1, REPEAT, REPEAT, REPEAT, REPEAT]) await x.look(s);
    await x.live();
    await handleTeamRequest({ type: "team-send", role: "implementer", text: "hi there friend" }, "pane-t", x.w.deps);
    await x.w.runner.redeliverWaiting();
    // Fields are not even looked at: a getter that throws is never called.
    debug.debugLog(x.store, "round", { get text() { throw new Error("formatted while off"); } });
    const debugFiles = (calls) => calls.filter((c) => String(c.arguments[0]).includes("debug"));
    assert.deepEqual(debugFiles(appends.mock.calls), []);
    assert.deepEqual(debugFiles(renames.mock.calls), []);
    assert.equal(existsSync(join(x.store.dir, "debug.jsonl")), false);
  } finally {
    appends.mock.restore();
    renames.mock.restore();
    x.cleanup();
  }
});

worldTest("debug on and off without a restart: aya debug on|off is read on its change", async (x) => {
  await setDebug(true);
  debug.debugLog(x.store, "probe", { n: 1 });
  await setDebug(false);
  debug.debugLog(x.store, "probe", { n: 2 });
  await setDebug(true);
  debug.debugLog(x.store, "probe", { n: 3 });
  assert.deepEqual(x.events().filter((e) => e.event === "probe").map((e) => e.n), [1, 3]);
});

debugTest("debug on | debug.jsonl rotates past 5 MB: the older half is debug.1.jsonl, the new file starts empty", async (x) => {
  assert.equal(debug.DEBUG_LOG_MAX_BYTES, 5 * 1024 * 1024);
  const file = join(x.store.dir, "debug.jsonl");
  writeFileSync(file, `${"y".repeat(debug.DEBUG_LOG_MAX_BYTES - 10)}\n`);
  debug.debugLog(x.store, "probe", { n: 1 });
  assert.equal(statSync(join(x.store.dir, "debug.1.jsonl")).size, debug.DEBUG_LOG_MAX_BYTES - 9);
  assert.deepEqual(x.events().map((e) => e.n), [1]);
});

debugTest("debug on | Aya's own strings (a hold reason) are cut at 300 characters, not at a message's 80", async (x) => {
  assert.equal(debug.OTHER_CHARS, 300);
  const reason = "r".repeat(debug.OTHER_CHARS + 50);
  debug.debugLog(x.store, "probe", { reason, text: reason });
  const [probe] = x.events().filter((e) => e.event === "probe");
  assert.equal(probe.reason, `${reason.slice(0, debug.OTHER_CHARS)}...`);
  assert.equal(probe.text, `${reason.slice(0, debug.MESSAGE_CHARS)}...`);
});

debugTest("debug on | a removed team's directory is not made again by a late decision", async (x) => {
  rmSync(x.store.dir, { recursive: true, force: true });
  debug.debugLog(x.store, "probe", { n: 1 });
  assert.equal(existsSync(x.store.dir), false);
});

test("debug on | a socket answer from a pane that names its team is logged once", async () => {
  await setDebug(true);
  const x = await world();
  try {
    await debug.debugAnswer(x.w.deps, { type: "team-start", team: "ux-review", cwd: x.t.project.directory }, { terminalId: "pane-t" }, Promise.resolve({ output: "started" }));
    assert.equal(x.events().filter((e) => e.event === "socket").length, 1);
  } finally {
    x.cleanup();
  }
});

test("debug on | a state is written when it changes for its pane: another pane's state between is no change", async () => {
  await setDebug(true);
  const x = await world();
  try {
    for (const pane of ["pane-t", "pane-i", "pane-t"]) debug.debugLog(x.store, "launch", { pane, verdict: "unknown" });
    assert.deepEqual(x.events().filter((e) => e.event === "launch").map((e) => e.pane), ["pane-t", "pane-i"]);
  } finally {
    x.cleanup();
  }
});

test("debug on | one line longer than the cap goes into an empty debug.jsonl, not lost to a rotation", async () => {
  await setDebug(true);
  const x = await world();
  try {
    const many = Array.from({ length: Math.ceil(debug.DEBUG_LOG_MAX_BYTES / 300) + 1 }, () => "z".repeat(300));
    debug.debugLog(x.store, "probe", { many });
    assert.equal(x.events().filter((e) => e.event === "probe").length, 1);
  } finally {
    x.cleanup();
  }
});
