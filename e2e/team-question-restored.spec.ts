// A question restored from disk with no saved session to tie it to the pane holds rounds only until the first
// is due (30 cadence minutes = 9 s here); the user's Enter still ends it.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, LEAD_TEAM, runningTeam, LEAD_ASKED_FILE, TYPED_TIMEOUT_MS } from "./helpers/team";

const MINUTE_MS = 300;
const base = runningTeam(LEAD_TEAM, agentPreset("quiet", "claude"), LEAD_ASKED_FILE);

test.use(teamMinute(base, MINUTE_MS));

test("a question from before the restart that no session confirms: rounds go on, the window says it is unconfirmed, Enter ends it", async ({ window, seeded }) => {
  const dialog = await openTeams(window);
  const card = dialog.getByTestId("team-ux-review");
  const leadLine = card.getByLabel("ux-review lead waiting");
  await expect(leadLine).toHaveText(/tester is waiting for you since \d\d:\d\d \(asked before the restart\): need the staging password/);
  const lead = () => teamLog(seeded.projectDir)("tab-left");
  await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/Round 1: no progress since/);
  await expect(leadLine).toHaveText(/tester asked you before the restart \(\d\d:\d\d\), not confirmed since; rounds go on: need the staging password/);
  await expect(card.getByLabel("tester status")).toContainText(/asked before the restart \(\d\d:\d\d\), not confirmed/);
  // The other order: a window that loads after main stopped holding on it reads the mark at its start.
  await window.reload();
  const reopened = await openTeams(window);
  await expect(reopened.getByTestId("team-ux-review").getByLabel("ux-review lead waiting")).toHaveText(/tester asked you before the restart \(\d\d:\d\d\), not confirmed since/);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await window.keyboard.type("use the test one");
  await window.keyboard.press("Enter");
  await expect.poll(() => lead(), { timeout: TYPED_TIMEOUT_MS }).toContain("use the test one");
  await window.getByTestId("teams-toggle").click();
  await expect(dialog.getByTestId("team-ux-review").getByLabel("ux-review lead waiting")).toHaveCount(0);
  await expect(dialog.getByTestId("team-ux-review").getByLabel("tester status")).not.toContainText("before the restart");
});
