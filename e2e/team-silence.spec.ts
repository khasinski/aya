// A team with no cadence is still watched: after SILENCE_FIRST of quiet the lead gets a round (the
// same text a real lead reads) and, if nobody answers, the window says stalled after STALL_AFTER.

import { SILENCE_FIRST_MIN, SILENCE_REPEAT_MIN, STALL_AFTER_MIN } from "../dist-electron/team-times.js";
import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamMinute, countMatches, LEAD_TEAM, runningTeam, QUIET_MINUTE_MS, QUIET_NO_ROUND_MS, TEAM_CLOCK_TIMEOUT_MS } from "./helpers/team";

/** Rounds from the silence before the stall: at SILENCE_FIRST, then every SILENCE_REPEAT until STALL_AFTER. */
const SILENCE_ROUNDS = (STALL_AFTER_MIN - SILENCE_FIRST_MIN) / SILENCE_REPEAT_MIN;
const seed = (mode: string) => teamMinute(runningTeam(LEAD_TEAM, agentPreset(mode, "claude")), QUIET_MINUTE_MS);

test.describe("a team with no rhythm and a silent implementer, and a lead who answers", () => {
  test.use(seed("lead-answers"));

  test("the lead gets a round from the silence, answers, and the window never says there is nothing to watch", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    const implementer = () => teamLog(seeded.projectDir)("tab-right");
    await expect(card.getByLabel("ux-review status")).not.toContainText("no rounds to watch");
    await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toMatch(/Aya round 1: .*no progress since \d\d:\d\d/);
    await expect.poll(() => lead()).toContain("ANSWERED lead-answers");
    await expect.poll(() => implementer()).toMatch(/from tester \| \d\d:\d\d\] decision: ship the retry/);
    expect(countMatches(implementer(), /Aya round \d+: run your round/g), "no rhythm, so no periodic round").toBe(0);
    // The lead's decision is a message, not a change to the repo: talking, and stalled on the repo once 12 s have passed.
    await expect(card.getByLabel("ux-review status")).toContainText(/no change to the repo since \d\d:\d\d \(1 message\)/, { timeout: TEAM_CLOCK_TIMEOUT_MS });
    await expect(card.getByLabel("ux-review status")).not.toContainText("stalled since");
  });
});

test.describe("a team with no rhythm where nobody answers", () => {
  test.use(seed("quiet"));

  test("three rounds from the silence, one that says stalled, and no more rounds", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const log = () => teamLog(seeded.projectDir)("tab-left");
    const rounds = () => countMatches(log(), /Aya round \d+: /g);
    await expect(card.getByLabel("ux-review status")).toContainText(/stalled: no change to the repo since \d\d:\d\d/, { timeout: TEAM_AGENT_READY_TIMEOUT_MS });
    await expect.poll(() => log()).toMatch(new RegExp(`Aya round ${SILENCE_ROUNDS + 1}: stalled: no change to the repo`));
    expect(countMatches(log(), /Aya round \d+: .*no progress since/g)).toBe(SILENCE_ROUNDS);
    await window.waitForTimeout(QUIET_NO_ROUND_MS);
    expect(rounds(), "a stalled team gets no more rounds").toBe(SILENCE_ROUNDS + 1);
  });
});
