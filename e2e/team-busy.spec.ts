// A round is not typed into an agent mid-turn (the CLI would queue one per tick): the stand-in shows Claude working and
// never finishes while rounds tick every ROUND_MS, and the tester's peer message still reaches it.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, BARE_TEAM, runningTeam, RHYTHM_MINUTE_MS } from "./helpers/team";

const TEAM = `${BARE_TEAM}\n## Cadence\nimplementer every 1 min\n`;

const ROUND_MS = RHYTHM_MINUTE_MS;

const SEED = runningTeam(TEAM, agentPreset("busy", "claude"));

test.describe("a running team whose implementer is busy working", () => {
  test.use(teamMinute(SEED, ROUND_MS));

  test("no round is typed into it, the peer message is, and the team is not stalled", async ({ window, seeded }) => {
    const log = teamLog(seeded.projectDir);
    await expect.poll(() => log("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("round 5 ready");
    await window.waitForTimeout(5 * ROUND_MS);
    expect(log("tab-right"), "rounds are held while the agent is busy").not.toMatch(/Aya round \d+:/);
    const dialog = await openTeams(window);
    await expect(dialog.getByTestId("team-ux-review").getByLabel("ux-review status")).not.toContainText("stalled");
  });
});
