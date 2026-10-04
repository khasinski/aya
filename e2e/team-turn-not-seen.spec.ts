// A pane that shows nothing after the pasted Enter did not take the message: the window and the sender
// say so and the team is not talking. A pane whose tty echoes the Enter is the control.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, TWO_ROLE_TEAM, agentPreset, openTeams, teamLog, teamMinute, runningTeam, RHYTHM_MINUTE_MS } from "./helpers/team";

const NOT_SEEN = "typed, not seen to start a turn";
// The team's clock looks once a cadence minute here (ROUND_CHECK_MS), so its progress has caught up within two; stalled only after 60.
const seed = (mode: string) => teamMinute(runningTeam(TWO_ROLE_TEAM, agentPreset(mode, "claude")), RHYTHM_MINUTE_MS);

test.describe("an implementer that never takes the Enter", () => {
  test.use(seed("deaf"));

  test("the message is typed, not seen to start a turn: in the window, to the sender, and not talk", async ({ window, seeded }) => {
    const log = teamLog(seeded.projectDir);
    await expect.poll(() => log("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("round 5 ready");
    await expect.poll(() => log("tab-right"), { message: "its Enter went" }).toContain("\r");
    await expect.poll(() => log("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("SENT written to implementer's pane (message 1), but not seen to start a turn; it is not resent");
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(dialog.getByLabel("ux-review messages").locator(".aya-chat-alert")).toHaveText(`⚠ ${NOT_SEEN}`);
    await window.waitForTimeout(2 * RHYTHM_MINUTE_MS);
    await expect(card.getByLabel("ux-review status")).toContainText("progressing");
    await expect(card.getByLabel("ux-review status")).not.toContainText("message");
  });
});

test.describe("an implementer whose tty echoes the Enter", () => {
  test.use(seed(""));

  test("the message is written and the team is talking", async ({ window, seeded }) => {
    const log = teamLog(seeded.projectDir);
    await expect.poll(() => log("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("SENT written to implementer's pane (message 1); this does not mean it was read");
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(card.getByLabel("ux-review status")).toContainText("(1 message)");
    await expect(dialog.getByLabel("ux-review messages").locator(".aya-chat-alert")).toHaveCount(0);
  });
});
