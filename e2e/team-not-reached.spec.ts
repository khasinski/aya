// Start refuses while the implementer sits on an approval prompt and the card marks it "Not reached".
// Once the prompt is answered the mark goes: it must not outlive the hold (it said a false thing for good).

import { test, expect } from "./fixtures";
import { EXPECT_TIMEOUT_MS } from "./timeouts";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamSeed, BARE_TEAM } from "./helpers/team";

const TEAM = `${BARE_TEAM}\n## Lead\ntester\n`;

const PROMPT_MS = 12_000;

test.describe("an implementer that answers its prompt after Start was refused", () => {
  test.use(teamSeed(TEAM, { presetList: [agentPreset(`ask-briefly ${PROMPT_MS}`, "claude")] }));

  test("'Not reached' is shown while the prompt is up and gone once it is answered", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect.poll(() => teamLog(seeded.projectDir)("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/SENT|FAIL/);
    await card.getByRole("button", { name: "Start", exact: true }).click();
    const marked = card.getByRole("status", { name: "implementer not reached" });
    await expect(marked).toHaveText("⚠ Not reached: shows an approval prompt");
    await expect(card.getByLabel("implementer status")).toHaveText("ready", { timeout: PROMPT_MS + EXPECT_TIMEOUT_MS });
    await expect(marked).toHaveCount(0);
  });
});
