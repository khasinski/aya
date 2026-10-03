// An always-approve lead runs `aya team start` on its own team (every second here, with and without its pane
// id): only the user resumes a team the user paused.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, countMatches, LEAD_TEAM, runningTeam, RHYTHM_MINUTE_MS } from "./helpers/team";

const base = runningTeam(LEAD_TEAM, agentPreset("lead-restarts", "claude"));

test.describe("a lead that runs aya team start on its own team", () => {
  test.use(teamMinute(base, RHYTHM_MINUTE_MS));

  test("refused while running, refused after the user's Pause (the window stays paused), and Resume is the user's", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    const implementer = () => teamLog(seeded.projectDir)("tab-right");
    for (const tag of ["id set", "id unset"]) {
      await expect.poll(lead, { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(new RegExp(`START-FAIL \\(${tag}\\) .*team ux-review: the team is running; use aya team send`));
    }
    await card.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(card.getByText("paused", { exact: true })).toBeVisible();
    const before = countMatches(lead(), /START-FAIL .*the user paused this team/g);
    for (const tag of ["id set", "id unset"]) {
      await expect.poll(lead).toMatch(new RegExp(`START-FAIL \\(${tag}\\) .*team ux-review: the user paused this team; only the user can resume it`));
    }
    await expect.poll(() => countMatches(lead(), /START-FAIL .*the user paused this team/g)).toBeGreaterThanOrEqual(before + 4);
    await expect(card.getByText("paused", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Resume" })).toBeVisible();
    expect(lead()).not.toContain("START-OK");
    expect(implementer()).not.toContain("1b27df1 is already measured");
    await expect(card).not.toContainText("1b27df1 is already measured");
    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    const running = countMatches(lead(), /the team is running; use aya team send/g);
    await expect.poll(() => countMatches(lead(), /the team is running; use aya team send/g)).toBeGreaterThan(running);
    expect(lead()).not.toContain("START-OK");
  });
});
