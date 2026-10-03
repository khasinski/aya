// An approval prompt drawn between the paste and Enter must not get the Enter (measured on real
// Claude: it approved the tool call). Enter is withheld and the sender told.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, teamLog, teamSeed, TWO_ROLE_TEAM } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";

const SETTLE_MS = 1_500;

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset("approval-after-paste", "claude")] }));

test("a prompt drawn between the paste and Enter gets no Enter, and the sender is told", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const read = teamLog(seeded.projectDir);
  await expect
    .poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS })
    .toMatch(/FAIL .*implementer: shows an approval prompt; it appeared after the text was typed; text left in the composer, Enter not sent/);
  await window.waitForTimeout(SETTLE_MS);
  const received = read("tab-right");
  expect(received).toContain("round 5 ready");
  expect(received).not.toContain("\r");
});
