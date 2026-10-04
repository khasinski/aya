// A Save in the Teams window that changes a running role's whoami: its pane is told to run it again, the role's row
// says it works from an older role, and the pane's own aya team whoami clears that (N3.3, finding 9).

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamSeed, TWO_ROLE_TEAM } from "./helpers/team";
import { firstTerminalShown } from "./helpers/terminal";

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset("quiet")] }));

test("a Save that changes the tester's role tells its pane, marks its row, and its whoami clears the mark", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  await expect
    .poll(async () => (await window.evaluate(() => window.aya.teamStart("e2e-proj", "ux-review"))).started, { timeout: TEAM_AGENT_READY_TIMEOUT_MS })
    .toBe(true);
  await window.evaluate(async () => {
    const team = (await window.aya.teamList("e2e-proj")).find((t) => t.name === "ux-review")!.definition!;
    const roles = team.roles.map((r) => (r.id === "tester" ? { ...r, mustNot: "rewrite the tests" } : r));
    await window.aya.teamSave("e2e-proj", { ...team, lead: "tester", roles }, false);
  });
  const read = teamLog(seeded.projectDir);
  await expect.poll(() => read("tab-left"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/from aya .*Your role in this team changed at \d\d:\d\d: run aya team whoami again/);
  expect(read("tab-right")).not.toMatch(/run aya team whoami again/);

  const dialog = await openTeams(window);
  await expect(dialog.getByLabel("tester older role")).toContainText(/started with an older role: it changed at \d\d:\d\d/);
  await expect(dialog.getByLabel("implementer older role")).toHaveCount(0);

  // The tester's pane runs aya team whoami itself (the agent's request file), and reads the new text.
  writeFileSync(join(seeded.projectDir, "whoami-request-tab-left"), "");
  const out = join(seeded.projectDir, "whoami-out-tab-left");
  await expect.poll(() => (existsSync(out) ? readFileSync(out, "utf8") : ""), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/must not +rewrite the tests/);
  await expect(dialog.getByLabel("tester older role")).toHaveCount(0, { timeout: TEAM_DELIVERY_TIMEOUT_MS });
});
