// A quiet team's lead who cannot unblock the work and asks the user (`aya status waiting`) shows as waiting for you,
// and the silence rounds stop until something moves; a lead who answers is in team-silence.spec.ts.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, countMatches, LEAD_TEAM, runningTeam, QUIET_MINUTE_MS, QUIET_NO_ROUND_MS, TEAM_CLOCK_TIMEOUT_MS } from "./helpers/team";

const base = runningTeam(LEAD_TEAM, agentPreset("lead-waits", "claude"));

test.describe("a quiet team, and a lead who cannot unblock it", () => {
  test.use(teamMinute(base, QUIET_MINUTE_MS));

  test("one round from the silence; the window says the lead is waiting for you, and no more rounds come", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("ANSWERED lead-waits");
    await expect(card.getByLabel("ux-review lead waiting")).toHaveText(/tester is waiting for you since \d\d:\d\d: need the staging password/);
    await expect(card.getByLabel("tester status")).toContainText(/waiting for you since \d\d:\d\d/);
    // The lead asked the user, so it gets no stall round either; the window says what the stall is on.
    await expect(card.getByLabel("ux-review status")).toContainText(/stalled: no change to the repo since \d\d:\d\d \(0 messages\)/, { timeout: TEAM_CLOCK_TIMEOUT_MS });
    // Several more repeat windows pass; the lead has asked the user and is not asked again, by the silence or the stall.
    await window.waitForTimeout(QUIET_NO_ROUND_MS);
    expect(countMatches(lead(), /Round \d+: (?:no progress since|stalled: no change to the repo)/g)).toBe(1);
  });
});
