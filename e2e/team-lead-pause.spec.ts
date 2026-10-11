// The lead ends the work: asked for a round by the silence clock, it answers with `aya team pause "why"`.
// The Teams window shows the team paused with the lead's reason in the chat, and no round comes after.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, countMatches, LEAD_TEAM, runningTeam, QUIET_MINUTE_MS } from "./helpers/team";

const base = runningTeam(LEAD_TEAM, agentPreset("lead-pauses", "claude"));

test.describe("a lead who decides the work is finished", () => {
  test.use(teamMinute(base, QUIET_MINUTE_MS));

  test("aya team pause: the window says paused and why, and no more rounds come", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("ANSWERED lead-pauses");
    await expect(card.getByText("paused", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(card).toContainText("tester (the lead) paused the team: no lower complexity is possible");
    const rounds = countMatches(lead(), /Aya round \d+: .*no progress since/g);
    await window.waitForTimeout(24 * QUIET_MINUTE_MS);
    expect(countMatches(lead(), /Aya round \d+: .*no progress since/g), "a paused team gets no more rounds").toBe(rounds);
  });
});
