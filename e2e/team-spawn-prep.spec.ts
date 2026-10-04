// A pane whose spawn main still prepares (a login-shell probe can take 20 s; held here by a test delay) is starting,
// not gone, and a tab closed in that gap never gets a process.

import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, teamLog, teamLogFile, teamSeed, TWO_ROLE_TEAM } from "./helpers/team";
import { askControl } from "./helpers/control";
import { fireShortcut } from "./helpers/shortcut";
import { firstTerminalShown } from "./helpers/terminal";
import { existsSync } from "node:fs";

// Longer than the host's 5 s kill marker.
const PREP_MS = 9_000;

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset()], seed: { launchEnv: { AYA_E2E_SPAWN_PREP_DELAY_MS: String(PREP_MS) } } }));

test("a pane whose spawn is still being prepared reads as starting up, and gets the message once it is up", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  const reply = await askControl(seeded.ayaHome, { type: "team-send", role: "implementer", text: "early report" });
  expect(reply.ok).toBe(false);
  expect(reply.error).toMatch(/implementer: is still starting up; nothing was typed/);
  const read = teamLog(seeded.projectDir);
  expect(read("tab-right"), "nothing was typed into a pane that does not exist yet").toBe("");
  await expect.poll(() => read("tab-right"), { timeout: PREP_MS + TEAM_AGENT_READY_TIMEOUT_MS }).toContain("early report");
});

test("a tab closed while its spawn is still being prepared never gets a process", async ({ app, window, seeded }) => {
  await firstTerminalShown(window);
  await fireShortcut(app, "close-tab");
  // The other tab, prepared in the same gap, is the clock: once it runs, the closed one's turn has passed.
  await expect.poll(() => existsSync(teamLogFile(seeded.projectDir, "tab-right")), { timeout: PREP_MS + TEAM_AGENT_READY_TIMEOUT_MS }).toBe(true);
  expect(existsSync(teamLogFile(seeded.projectDir, "tab-left")), "the closed tab's agent must not have started").toBe(false);
});
