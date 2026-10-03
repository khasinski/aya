// A last answer saying "I'm waiting for approval" above an empty composer asks nothing: the peer message
// is typed and the Teams window does not say "waiting for you".

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamSeed, BARE_TEAM } from "./helpers/team";

for (const [agent, mode] of [["claude", "transcript-waiting"], ["codex", "transcript-waiting-codex"], ["opencode", "transcript-waiting-opencode"], ["grok", "transcript-waiting-grok"]]) {
  test.describe(`${agent}`, () => {
    test.use(teamSeed(BARE_TEAM, { presetList: [agentPreset(mode, agent)] }));

    test("a pane whose transcript says it waits for approval, at an empty composer, takes the message", async ({ window, seeded }) => {
      const log = teamLog(seeded.projectDir);
      await expect.poll(() => log("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("round 5 ready");
      const dialog = await openTeams(window);
      await expect(dialog.getByTestId("team-ux-review")).not.toContainText("waiting for you");
    });
  });
}
