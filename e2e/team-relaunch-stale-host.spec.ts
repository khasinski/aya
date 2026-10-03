// A running team across a real quit and relaunch of the same AYA_HOME: the
// second app life reads what the first left on disk, and its panes start over.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, hostPidsForHome, PTY_HOST_SCRIPT } from "./fixtures";
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

test.describe("a stale pty host reaped at boot", () => {
  const hostScript = PTY_HOST_SCRIPT;
  const built = readFileSync(hostScript);
  // A host started from other bytes than the ones the next app life finds is stale.
  test.afterEach(() => writeFileSync(hostScript, built));

  test("the agents respawn under the same roles, and the held report is typed once", async ({ seeded }) => {
    test.setTimeout(TEAM_RELAUNCH_TEST_TIMEOUT_MS);
    const env = relaunchEnv(seeded, RELAUNCH_MINUTE_MS, "0", E2E_REDELIVERY_MS);
    const read = teamLog(seeded.projectDir);
    const first = await launch(env);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: shows an approval prompt/);
    await expect.poll(() => roundsIn(read("tab-left")).length, { timeout: ROUND_WAIT_MS }).toBeGreaterThan(0);
    const assignments = readAssignments(seeded.ayaHome);
    const hostsBefore = hostPidsForHome(seeded.ayaHome);
    expect(hostsBefore.length).toBeGreaterThan(0);
    await quit(first.app);
    expect(hostPidsForHome(seeded.ayaHome), "the host outlives the app").toEqual(hostsBefore);
    const lastRound = Math.max(...roundsIn(read("tab-left")));

    appendFileSync(hostScript, "\n// rebuilt\n");
    await launch(env);
    writeFileSync(hostScript, built);
    expect(hostPidsForHome(seeded.ayaHome).filter((pid) => hostsBefore.includes(pid)), "the old host is gone").toEqual([]);

    await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS + 3 * TEAM_REDELIVERY_MS }).toMatch(/peer report from life 1/);
    expect(read("tab-right")).not.toMatch(/old round/);
    expect(readAssignments(seeded.ayaHome)).toEqual(assignments);
    await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/WHOAMI team +ux-review\nyou +tester/);
    await expect.poll(() => roundsIn(read("tab-left")).length, { timeout: ROUND_WAIT_MS }).toBeGreaterThan(0);
    expect(Math.min(...roundsIn(read("tab-left")))).toBeGreaterThan(lastRound);
    // Another redelivery pass finds nothing owed.
    await new Promise((resolve) => setTimeout(resolve, ANOTHER_PASS_MS));
    expect(countMatches(read("tab-right"), /peer report from life 1/g)).toBe(1);
  });
});
