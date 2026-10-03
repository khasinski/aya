// The round brake in the real app: a lead that does not answer gets three rounds on its rhythm,
// then none, and the window says the rounds wait for it; its answer (a message) brings three more.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNANSWERED_ROUNDS } from "../dist-electron/team-progress.js";
import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, LEAD_TEAM, runningTeam, RHYTHM_MINUTE_MS, TEAM_CLOCK_TIMEOUT_MS } from "./helpers/team";

const TEAM = `${LEAD_TEAM}\n## Cadence\ntester every 1 min\n`;

const base = runningTeam(TEAM, agentPreset("quiet", "claude"));

test.describe("a lead that does not answer its rounds", () => {
  test.use(teamMinute(base, RHYTHM_MINUTE_MS));

  test("gets three rounds, then none until it answers; the window says the rounds wait for it", async ({ window, seeded }) => {
    const card = (await openTeams(window)).getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    const rounds = () => (lead().match(/Round \d+: run your round/g) ?? []).length;
    await expect(card.getByLabel("ux-review status")).toContainText(`rounds wait for tester to answer (${UNANSWERED_ROUNDS} unanswered)`, { timeout: TEAM_AGENT_READY_TIMEOUT_MS });
    expect(rounds()).toBe(UNANSWERED_ROUNDS);
    await window.waitForTimeout(5 * RHYTHM_MINUTE_MS);
    expect(rounds(), "five more beats, no round").toBe(UNANSWERED_ROUNDS);

    writeFileSync(join(seeded.projectDir, "send-request-tab-left"), "implementer take the second half of the solver");
    await expect.poll(lead).toContain("SENT on request");
    // The answer brings three more rounds; unanswered again, they stop again.
    await expect.poll(rounds, { timeout: TEAM_CLOCK_TIMEOUT_MS }).toBe(2 * UNANSWERED_ROUNDS);
    await window.waitForTimeout(5 * RHYTHM_MINUTE_MS);
    expect(rounds()).toBe(2 * UNANSWERED_ROUNDS);
  });
});
