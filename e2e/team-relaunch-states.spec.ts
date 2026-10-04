// A team's run state across real quits and relaunches of one AYA_HOME: paused and never-started teams get no rounds
// back, Resume goes on from the last round, Aya's old entries stay unsent and a peer's held report is typed once.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { SeededEnv } from "./helpers/seed";
import {
  agentPreset,
  openTeams,
  RELAUNCH_MINUTE_MS,
  RELAUNCH_REDELIVERY_MS as E2E_REDELIVERY_MS,
  relaunchEnv,
  ROUND_WAIT_MS,
  roundsIn,
  TEAM_AGENT_READY_TIMEOUT_MS,
  TEAM_STATE_DIR,
  teamLog,
  teamSeed,
  heldEntry,
  RELAUNCH_TEAM,
  countMatches,
} from "./helpers/team";
import { trackLaunches } from "./helpers/relaunch";
import { TEAM_RELAUNCH_TEST_TIMEOUT_MS } from "./timeouts";

// Long enough for three rounds and two redelivery passes to have happened had the team been running.
const QUIET_MS = 3 * RELAUNCH_MINUTE_MS + 2 * E2E_REDELIVERY_MS;

/** What a life leaves held when it quits: an Aya round for the implementer and a peer's report. */
const LEFT_HELD =
  heldEntry(100, "aya", "implementer", "Round 3: old round") + heldEntry(101, "tester", "implementer", "peer report left held");

test.use(
  teamSeed(RELAUNCH_TEAM, {
    presetList: [agentPreset("", "claude")],
    ayaHomeFiles: {
      [`${TEAM_STATE_DIR}/state.json`]: JSON.stringify({
        paused: false,
        started: true,
        lastRound: 3,
      }),
    },
  }),
);

const stateOf = (ayaHome: string) =>
  JSON.parse(readFileSync(join(ayaHome, TEAM_STATE_DIR, "state.json"), "utf8"));

const { launch: launchTracked, quit } = trackLaunches();
async function launch(seeded: SeededEnv) {
  const { app, window } = await launchTracked(seeded);
  const card = (await openTeams(window)).getByTestId("team-ux-review");
  return { app, card };
}

test("a team paused in one app life stays quiet in the next, and Resume goes on from the last round", async ({
  seeded,
}) => {
  test.setTimeout(TEAM_RELAUNCH_TEST_TIMEOUT_MS);
  const env = relaunchEnv(seeded, RELAUNCH_MINUTE_MS, "1", E2E_REDELIVERY_MS);
  const read = teamLog(seeded.projectDir);
  const logFile = join(seeded.ayaHome, TEAM_STATE_DIR, "log.jsonl");

  const first = await launch(env);
  await expect
    .poll(() => roundsIn(read("tab-left")).length, {
      timeout: TEAM_AGENT_READY_TIMEOUT_MS + ROUND_WAIT_MS,
    })
    .toBeGreaterThan(0);
  await first.card.getByRole("button", { name: "Pause" }).click();
  await expect(
    first.card.getByRole("button", { name: "Resume" }),
  ).toBeVisible();
  // The agent logs a round at its Enter, Aya writes it just after: read state.json once it has.
  await expect
    .poll(() => stateOf(seeded.ayaHome).lastRound)
    .toBeGreaterThanOrEqual(4);
  const lastRound = stateOf(seeded.ayaHome).lastRound;
  await quit(first.app);
  appendFileSync(logFile, LEFT_HELD);

  const second = await launch(env);
  await expect(second.card).toContainText("paused");
  // The agent is up: its own send is refused because the team is paused.
  await expect
    .poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS })
    .toMatch(/team ux-review is paused; nothing was sent/);
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  expect(
    roundsIn(read("tab-left")),
    "a paused team gets no rounds back",
  ).toEqual([]);
  expect(read("tab-right"), "a paused team takes no held message").not.toMatch(
    /peer report left held|old round/,
  );
  expect(stateOf(seeded.ayaHome)).toMatchObject({
    paused: true,
    started: true,
    lastRound,
  });

  // Resume: the numbering goes on, the peer's report goes out once, Aya's old round never.
  await second.card.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(() => roundsIn(read("tab-left")).length, { timeout: ROUND_WAIT_MS })
    .toBeGreaterThan(0);
  expect(Math.min(...roundsIn(read("tab-left")))).toBe(lastRound + 1);
  await expect
    .poll(() => countMatches(read("tab-right"), /peer report left held/g), {
      timeout: 3 * E2E_REDELIVERY_MS,
    })
    .toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 2 * E2E_REDELIVERY_MS));
  expect(countMatches(read("tab-right"), /peer report left held/g)).toBe(1);
  expect(read("tab-right")).not.toMatch(/old round/);
  const resumedTo = stateOf(seeded.ayaHome).lastRound;
  await quit(second.app);

  // The pane log still holds life 2's rounds until the new agent truncates it, so wait for a round beyond them.
  await launch(env);
  await expect
    .poll(
      () => roundsIn(read("tab-left")).filter((n) => n > resumedTo).length,
      {
        timeout: TEAM_AGENT_READY_TIMEOUT_MS + ROUND_WAIT_MS,
      },
    )
    .toBeGreaterThan(0);
  expect(Math.min(...roundsIn(read("tab-left")))).toBe(resumedTo + 1);
  expect(read("tab-right")).not.toMatch(/old round|peer report left held/);
});

test.describe("a team never started", () => {
  test.use(teamSeed(RELAUNCH_TEAM, { presetList: [agentPreset("", "claude")] }));

  test("gets no rounds in any app life; Aya's old entries stay unsent", async ({
    seeded,
  }) => {
    test.setTimeout(TEAM_RELAUNCH_TEST_TIMEOUT_MS);
    const env = relaunchEnv(seeded, RELAUNCH_MINUTE_MS, "1", E2E_REDELIVERY_MS);
    const read = teamLog(seeded.projectDir);
    const logFile = join(seeded.ayaHome, TEAM_STATE_DIR, "log.jsonl");
    for (const life of [1, 2]) {
      const { app, card } = await launch(env);
      await expect(card.getByRole("button", { name: "Start" })).toBeVisible();
      await expect(card.getByRole("button", { name: "Pause" })).toHaveCount(0);
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
      expect(roundsIn(read("tab-left")), `life ${life}: no rounds`).toEqual([]);
      expect(read("tab-right"), `life ${life}`).not.toMatch(
        /old round|Delivery test/,
      );
      await quit(app);
      if (life === 1) appendFileSync(logFile, LEFT_HELD);
    }
  });
});
