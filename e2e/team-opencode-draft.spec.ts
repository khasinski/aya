// Text the user half-typed into OpenCode's composer: a team message is not typed after it, where
// Enter would submit both as one. Once the user clears the composer the message is delivered.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, teamLog, teamSeed, TWO_ROLE_TEAM, DELIVERY_SLACK_MS } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";
import { TEAM_REDELIVERY_MS } from "./timeouts";

const DRAFT_MS = 8_000;

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset(`opencode-draft ${DRAFT_MS}`, "opencode")] }));

test("a message for an OpenCode pane with a draft is held, then typed once the draft is gone", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/FAIL .*implementer: has text the user is typing/);
  expect(read("tab-right"), "nothing was typed after the draft").not.toContain("round 5 ready");
  await expect.poll(() => read("tab-right"), { timeout: DRAFT_MS + 2 * TEAM_REDELIVERY_MS + DELIVERY_SLACK_MS }).toContain("round 5 ready");
});
