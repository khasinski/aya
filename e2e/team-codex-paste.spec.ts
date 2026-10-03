// Codex takes fast raw input for a paste and swallows the Enter behind it, so a long team
// message must reach it as a bracketed paste ("codex-paste" models that rule).

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, agentPreset, teamLog, teamSeed, TWO_ROLE_TEAM } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset("codex-paste", "codex")] }));

test("a 900+ character team message is submitted in a Codex-like pane, not left in its composer", async ({
  window,
  seeded,
}) => {
  await firstTerminalShown(window);
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-left"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/SENT written to implementer's pane/);
  await expect
    .poll(() => read("tab-right"), { timeout: TEAM_DELIVERY_TIMEOUT_MS })
    .toMatch(/SUBMITTED \[team ux-review \| from tester \| \d\d:\d\d\] long report: (finding ){120}end\n/);
  expect(read("tab-right")).not.toContain("SWALLOWED-ENTER");
});
