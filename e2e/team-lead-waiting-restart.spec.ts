// A lead's question (`aya status waiting`) outlives a quit, from agent-waiting.json under AYA_HOME.
// The stand-in agent is quiet, so nothing asks again.

import { test, expect } from "./fixtures";
import { agentPreset, openTeams, LEAD_TEAM, runningTeam, LEAD_ASKED_FILE } from "./helpers/team";

const base = runningTeam(LEAD_TEAM, agentPreset("quiet", "claude"), LEAD_ASKED_FILE);

test.use(base);

test("a question the lead asked before the quit is still there after the relaunch", async ({ window }) => {
  const dialog = await openTeams(window);
  const card = dialog.getByTestId("team-ux-review");
  // Asked before the restart: its rounds wait for it until the pane's session is checked.
  await expect(card.getByLabel("ux-review lead waiting")).toHaveText(/tester is waiting for you since \d\d:\d\d \(asked before the restart\): need the staging password/);
  await expect(card.getByLabel("tester status")).toContainText(/waiting for you since \d\d:\d\d/);
});
