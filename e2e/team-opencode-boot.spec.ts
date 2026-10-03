// OpenCode draws nothing for seconds after it starts, so a message typed then goes nowhere: the tester's send at 3 s to
// a stand-in booting for BOOT_MS is held, then typed once the OpenCode screen is up.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, agentPreset, teamLog, teamSeed, TWO_ROLE_TEAM } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";

const BOOT_MS = 8_000;

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset(`opencode-boot ${BOOT_MS}`, "opencode")] }));

test("a message sent while OpenCode is still starting is held, then typed once it is up", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS + TEAM_DELIVERY_TIMEOUT_MS }).toContain("round 5 ready");
  expect(read("tab-right"), "nothing was typed before the composer was drawn").not.toContain("EARLY");
});
