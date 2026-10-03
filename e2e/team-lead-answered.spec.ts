// The lead asks the user (`aya status waiting`), the window says so, the user types the answer into the lead's pane:
// the Teams window must stop saying the lead is waiting for them.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, LEAD_TEAM, runningTeam, QUIET_MINUTE_MS, TYPED_TIMEOUT_MS } from "./helpers/team";

const base = runningTeam(LEAD_TEAM, agentPreset("lead-waits", "claude"));

test.use(teamMinute(base, QUIET_MINUTE_MS));

test("the user answers in the lead's pane: the window no longer says the lead is waiting for them", async ({ window, seeded }) => {
  const dialog = await openTeams(window);
  const card = dialog.getByTestId("team-ux-review");
  const lead = () => teamLog(seeded.projectDir)("tab-left");
  await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("ANSWERED lead-waits");
  const waiting = card.getByLabel("ux-review lead waiting");
  await expect(waiting).toHaveText(/tester is waiting for you since \d\d:\d\d: need the staging password/);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await window.keyboard.type("the password is hunter2");
  await window.keyboard.press("Enter");
  await expect.poll(() => lead(), { timeout: TYPED_TIMEOUT_MS }).toContain("the password is hunter2");
  await window.getByTestId("teams-toggle").click();
  await expect(dialog.getByTestId("team-ux-review").getByLabel("ux-review lead waiting")).toHaveCount(0);
  await expect(dialog.getByTestId("team-ux-review").getByLabel("tester status")).not.toContainText("waiting for you");
});
