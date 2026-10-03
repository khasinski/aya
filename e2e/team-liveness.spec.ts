// A stalled team and a role blocked on its own CLI show in the Teams window: the tester sits on a real OpenCode question,
// the team stalls after 60 cadence minutes (QUIET_MINUTE_MS each) and its rounds stop; a block counts after BLOCKED_MS.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, BARE_TEAM, runningTeam, QUIET_MINUTE_MS } from "./helpers/team";

const RHYTHM_MIN = 5;
const TEAM = `${BARE_TEAM}\n## Cadence\nimplementer every ${RHYTHM_MIN} min\n`;

const ROUND_MS = RHYTHM_MIN * QUIET_MINUTE_MS;
const BLOCKED_MS = 2_000;

const SEED = runningTeam(TEAM, agentPreset("plan", "opencode"));

test.describe("a running team whose tester waits on OpenCode's plan question", () => {
  test.use(teamMinute(SEED, QUIET_MINUTE_MS, { AYA_E2E_TEAM_BLOCKED_MS: String(BLOCKED_MS) }));

  test("real ticks type rounds until the repo's clock runs out, then skip them; the window says stalled and who waits", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const rounds = () => (teamLog(seeded.projectDir)("tab-right").match(/Round \d+:/g) ?? []).length;
    await expect(card.getByLabel("ux-review status")).toContainText(/stalled since \d\d:\d\d/, { timeout: TEAM_AGENT_READY_TIMEOUT_MS });
    await expect(card.getByLabel("ux-review status")).toContainText("tester is waiting for you in its CLI");
    await expect(card.getByLabel("tester status")).toContainText(/waiting for you since \d\d:\d\d/);
    await expect(card.getByLabel("implementer status")).toHaveText("ready");
    await expect.poll(() => teamLog(seeded.projectDir)("tab-right")).toMatch(/Round \d+: stalled: no change to the repo/);
    const typed = rounds();
    expect(typed, "a round every 5 min of the 60 before the stall").toBeGreaterThan(3);
    await window.waitForTimeout(3 * ROUND_MS);
    expect(rounds(), "a stalled team gets no more rounds").toBe(typed);
  });
});

// OpenCode's permission dialog (recorded, 80 columns) replaces the composer: it is a hold, not a free pane.
test.describe("a running team whose tester waits on OpenCode's permission dialog", () => {
  const seed = runningTeam(TEAM, agentPreset("permission", "opencode"));
  test.use(teamMinute(seed, QUIET_MINUTE_MS, { AYA_E2E_TEAM_BLOCKED_MS: String(BLOCKED_MS) }));

  test("the window says the tester waits for you in its CLI", async ({ window }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(card.getByLabel("tester status")).toContainText(/waiting for you since \d\d:\d\d/, { timeout: TEAM_AGENT_READY_TIMEOUT_MS });
    await expect(card.getByLabel("ux-review status")).toContainText("tester is waiting for you in its CLI");
  });
});
