// A running team across a real quit and relaunch of the same AYA_HOME: the second app
// life reads what the first left on disk; its agents start over, or survive with the pty host.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { SeededEnv } from "./helpers/seed";
import {
  agentPreset,
  RELAUNCH_MINUTE_MS,
  RELAUNCH_REDELIVERY_MS as E2E_REDELIVERY_MS,
  readAssignments,
  relaunchEnv,
  ROUND_WAIT_MS,
  roundsIn,
  TEAM_AGENT_READY_TIMEOUT_MS,
  TEAM_STATE_DIR,
  teamLog,
  heldEntry,
  runningTeam,
  RELAUNCH_TEAM,
  countMatches,
} from "./helpers/team";
import { trackLaunches } from "./helpers/relaunch";
import { firstTerminalShown } from "./helpers/terminal";
import { TEAM_REDELIVERY_MS, TEAM_RELAUNCH_TEST_TIMEOUT_MS } from "./timeouts";

/** Long enough for another redelivery pass to have run. */
const ANOTHER_PASS_MS = 2 * E2E_REDELIVERY_MS + 1_000;

const OLD_ROUND_LOG = heldEntry(1, "aya", "implementer", "Round 1: old round");

test.use(
  // An earlier session's round for the implementer, never typed: it is Aya's, so it is stale.
  runningTeam(RELAUNCH_TEAM, agentPreset("relaunch", "claude"), { [`${TEAM_STATE_DIR}/log.jsonl`]: OLD_ROUND_LOG }),
);

const { launch: launchTracked, quit } = trackLaunches();

async function launch(seeded: SeededEnv) {
  const started = await launchTracked(seeded);
  await firstTerminalShown(started.window);
  return started;
}

test("a relaunch that restarts the agents keeps the panes, counts on from the last round and delivers only the held peer message", async ({
  seeded,
}) => {
  test.setTimeout(TEAM_RELAUNCH_TEST_TIMEOUT_MS);
  const env = relaunchEnv(seeded, RELAUNCH_MINUTE_MS, "1", E2E_REDELIVERY_MS);
  const first = await launch(env);
  const read = teamLog(seeded.projectDir);
  // Life 1: the implementer sits on an approval prompt, so the tester's report is held; the rounds reach the tester.
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: shows an approval prompt/);
  await expect.poll(() => roundsIn(read("tab-left")).length, { timeout: ROUND_WAIT_MS }).toBeGreaterThan(0);
  const assignments = readAssignments(seeded.ayaHome);

  await quit(first.app);
  const lastRound = Math.max(...roundsIn(read("tab-left")));
  await launch(env);

  // Life 2: the implementer's agent draws a composer this time; redelivery then types the peer's report.
  await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS + 3 * TEAM_REDELIVERY_MS }).toMatch(/peer report from life 1/);
  expect(read("tab-right")).not.toMatch(/old round/);
  expect(readAssignments(seeded.ayaHome)).toEqual(assignments);
  // A pane restored at boot asks who it is before anything else.
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/WHOAMI team +ux-review\nyou +tester/);
  await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/WHOAMI team +ux-review\nyou +implementer/);
  // The round counter continues instead of starting at 1 again.
  await expect.poll(() => roundsIn(read("tab-left")).length, { timeout: ROUND_WAIT_MS }).toBeGreaterThan(0);
  expect(Math.min(...roundsIn(read("tab-left")))).toBeGreaterThan(lastRound);
  expect(countMatches(read("tab-right"), /peer report from life 1/g)).toBe(1);
  // After the later redelivery passes too: a stale round of Aya's must not surface late.
  expect(read("tab-right")).not.toMatch(/old round/);
});

test.describe("the pty host outliving the app", () => {
  test.use(runningTeam(RELAUNCH_TEAM, agentPreset("ask-until-released", "claude"), { [`${TEAM_STATE_DIR}/log.jsonl`]: OLD_ROUND_LOG }));

  test("keeps the agents running, and the held report is typed once the reused pane is free", async ({ seeded }) => {
    test.setTimeout(TEAM_RELAUNCH_TEST_TIMEOUT_MS);
    // The same agent logs every round across both lives: at a 1 s cadence a quit often lands while one is typed.
    const env = relaunchEnv(seeded, RELAUNCH_MINUTE_MS, "0", E2E_REDELIVERY_MS);
    const read = teamLog(seeded.projectDir);
    const first = await launch(env);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: shows an approval prompt/);
    await expect.poll(() => roundsIn(read("tab-left")).length, { timeout: ROUND_WAIT_MS }).toBeGreaterThan(0);
    // The approval prompt is still up at quit, however late the round came; it clears while no app is running.
    expect(read("tab-right")).not.toMatch(/round 5 ready/);
    await quit(first.app);
    const before = read("tab-left");
    const lastRound = Math.max(...roundsIn(before));
    writeFileSync(join(seeded.projectDir, "prompt-release-tab-right"), "");
    await expect.poll(() => existsSync(join(seeded.projectDir, "prompt-cleared-tab-right"))).toBe(true);

    // The surviving agent asks who it is while no Aya is listening: it waits for the relaunch.
    writeFileSync(join(seeded.projectDir, "whoami-request-tab-left"), "");
    await launch(env);
    await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS + 2 * TEAM_REDELIVERY_MS }).toMatch(/round 5 ready/);
    // The same agent process: a restarted one would have truncated its log.
    expect(read("tab-left").startsWith(before)).toBe(true);
    const whoamiOut = join(seeded.projectDir, "whoami-out-tab-left");
    await expect.poll(() => (existsSync(whoamiOut) ? readFileSync(whoamiOut, "utf8") : ""), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/you +tester/);
    expect(read("tab-right")).not.toMatch(/old round/);
    // Another redelivery pass finds nothing owed.
    await new Promise((resolve) => setTimeout(resolve, ANOTHER_PASS_MS));
    expect(countMatches(read("tab-right"), /round 5 ready/g)).toBe(1);
    await expect.poll(() => Math.max(...roundsIn(read("tab-left")))).toBeGreaterThan(lastRound);
    const rounds = roundsIn(read("tab-left"));
    expect(rounds).toEqual([...rounds].sort((a, b) => a - b));
    expect(new Set(rounds).size).toBe(rounds.length);
    expect(read("tab-right")).not.toMatch(/old round/);
  });
});
