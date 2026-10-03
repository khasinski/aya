// A CLI with no composer rule (kilo) is "starting up" until its screen is still for SCREEN_SETTLE_MS: the stand-in draws
// every 300 ms for BOOT_MS, and the tester's send at about 3 s is held, then typed once the screen settled.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, agentPreset, teamLog, teamSeed, TWO_ROLE_TEAM } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";

const BOOT_MS = 6_000;

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset(`drawing-boot ${BOOT_MS}`, "kilo")] }));

test("a message sent while a kilo pane still draws its start-up is held, then typed once its screen settles", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS + TEAM_DELIVERY_TIMEOUT_MS }).toContain("round 5 ready");
  expect(read("tab-right"), "nothing was typed while the screen still changed").not.toContain("EARLY");
});
