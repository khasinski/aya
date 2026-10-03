// An `aya team` call from a restored pane that lands before the window loaded is answered from the saved team or
// refused with the reason, never "belongs to no open project": the control socket is up before the window.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { askControl } from "./helpers/control";
import { agentPreset, TEAM_AGENT_READY_TIMEOUT_MS, teamLog, teamSeed, TWO_ROLE_TEAM } from "./helpers/team";
import { AGENT_TEST_TIMEOUT_MS, TEAM_REDELIVERY_MS } from "./timeouts";

const SOCKET_POLL_MS = 10;

test.use(teamSeed(TWO_ROLE_TEAM, { presetList: [agentPreset("quiet", "claude")] }));

test("whoami and send sent as soon as the control socket appears are answered or refused with the reason", async ({ app, seeded }) => {
  test.setTimeout(AGENT_TEST_TIMEOUT_MS);
  await expect.poll(() => existsSync(join(seeded.ayaHome, "aya.sock")), { intervals: [SOCKET_POLL_MS] }).toBe(true);

  const who = await askControl<{ ok: boolean; output?: string; error?: string }>(seeded.ayaHome, { type: "team-whoami" });
  expect(who).toMatchObject({ ok: true });
  expect(who.output).toMatch(/team +ux-review\nyou +tester/);

  const sent = await askControl<{ ok: boolean; output?: string; error?: string }>(seeded.ayaHome, { type: "team-send", role: "implementer", text: "early report" });
  const answer = sent.ok ? sent.output : sent.error;
  expect(answer).not.toMatch(/belongs to no open project|no team role/);
  expect(answer).toMatch(/written to implementer's pane|implementer: (is not running|is still starting up|no pane assigned)/);

  // A message refused for a pane that is not up yet is kept and typed once the pane draws its composer.
  await app.firstWindow();
  await expect.poll(() => teamLog(seeded.projectDir)("tab-right"), { timeout: TEAM_AGENT_READY_TIMEOUT_MS + 2 * TEAM_REDELIVERY_MS }).toMatch(/early report/);
});
