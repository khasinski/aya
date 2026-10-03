// The rhythm's role (implementer) runs an agent that exits: after UNREACHED_ROUNDS (3) rounds, one every
// ROUND_MS, that could not be typed, the window names it as unreached.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNREACHED_ROUNDS } from "../dist-electron/team-progress.js";
import { test, expect, closeAndWait, launchApp } from "./fixtures";
import { TEAM_RELAUNCH_TEST_TIMEOUT_MS } from "./timeouts";
import {
  TEAM_AGENT_READY_TIMEOUT_MS,
  TEAM_STATE_DIR,
  agentPreset,
  openTeams,
  relaunchEnv,
  teamSeed,
  BARE_TEAM,
  RHYTHM_MINUTE_MS,
  roundsIn,
  teamLog,
} from "./helpers/team";

const TEAM = `${BARE_TEAM}\n## Cadence\nimplementer every 1 min\n`;

const ROUND_MS = RHYTHM_MINUTE_MS;

const SEED = teamSeed(TEAM, {
  presetList: [agentPreset("exit")],
  ayaHomeFiles: {
    [`${TEAM_STATE_DIR}/state.json`]: JSON.stringify({
      paused: false,
      started: true,
    }),
  },
});

test.use({
  seedOptions: {
    ...SEED.seedOptions,
    launchEnv: {
      ...SEED.seedOptions.launchEnv,
      AYA_E2E_TEAM_MINUTE_MS: String(ROUND_MS),
    },
  },
});

test("after 3 rounds that could not be typed the window names the implementer, and not 'progressing'", async ({
  window,
}) => {
  const dialog = await openTeams(window);
  const status = dialog
    .getByTestId("team-ux-review")
    .getByLabel("ux-review status");
  await expect(status).toContainText(
    /no round typed to implementer since \d\d:\d\d: its pane is not running/,
    { timeout: TEAM_AGENT_READY_TIMEOUT_MS },
  );
  await expect(status).not.toContainText(/progressing|quiet/);
  await expect(
    dialog.getByTestId("team-ux-review").getByLabel("implementer status"),
  ).toContainText("not running");
});

test("the run of missed rounds is kept across a quit, and a respawned agent taking a round ends it", async ({
  seeded,
}) => {
  test.setTimeout(TEAM_RELAUNCH_TEST_TIMEOUT_MS);
  // Stop at the first received round, rather than racing a 1.5 s exit against
  // startup and the unanswered-round brake. Each life must take that round.
  writeFileSync(
    join(seeded.ayaHome, "presets.json"),
    JSON.stringify({ presets: [agentPreset("exit-on-round")] }),
  );
  const env = relaunchEnv(seeded, ROUND_MS);
  const receivedRounds = () => roundsIn(teamLog(seeded.projectDir)("tab-right"));
  const missed = () =>
    JSON.parse(
      readFileSync(
        join(seeded.ayaHome, TEAM_STATE_DIR, "progress.json"),
        "utf8",
      ),
    ).unreached;
  const line =
    /no round typed to implementer since \d\d:\d\d: its pane is not running/;
  const open = async () => {
    const app = await launchApp(env);
    const window = await app.firstWindow();
    const status = (await openTeams(window))
      .getByTestId("team-ux-review")
      .getByLabel("ux-review status");
    return { app, status };
  };

  const first = await open();
  await expect(first.status).toContainText(line, {
    timeout: TEAM_AGENT_READY_TIMEOUT_MS,
  });
  expect(receivedRounds(), "the first agent took one round before exiting").toHaveLength(1);
  const before = missed();
  expect(before.rounds).toBeGreaterThanOrEqual(UNREACHED_ROUNDS);
  await closeAndWait(first.app);

  expect(missed(), "kept on disk across the quit").toMatchObject({
    role: "implementer",
    since: before.since,
  });
  const second = await open();
  try {
    await expect(second.status).toContainText(line, {
      timeout: TEAM_AGENT_READY_TIMEOUT_MS,
    });
    expect(receivedRounds(), "the respawned agent took one round before exiting").toHaveLength(1);
    // The respawned agent is alive for a moment and takes a round, which ends the old run.
    expect(
      Date.parse(missed().since),
      "a new run, after the agent took a round",
    ).toBeGreaterThan(Date.parse(before.since));
  } finally {
    await closeAndWait(second.app);
  }
});
