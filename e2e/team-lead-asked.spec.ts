// A "waiting" from Aya's status hook (AYA_VIA=hook, an idle composer) is a finished turn: only a question the lead
// asked holds rounds.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, TEAM_STATE_DIR, agentPreset, openTeams, teamLog, teamMinute, countMatches, LEAD_TEAM, runningTeam, QUIET_MINUTE_MS, QUIET_NO_ROUND_MS, TEAM_CLOCK_TIMEOUT_MS, TYPED_TIMEOUT_MS } from "./helpers/team";

const seed = (mode: string) => teamMinute(runningTeam(LEAD_TEAM, agentPreset(mode, "claude")), QUIET_MINUTE_MS);
const skipLines = (ayaHome: string) => {
  try {
    return readFileSync(join(ayaHome, TEAM_STATE_DIR, "log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { from: string; to: string; text: string })
      .filter((m) => m.from === "aya" && /skipped/.test(m.text))
      .map((m) => `${m.to}: ${m.text}`);
  } catch {
    return [];
  }
};

test.describe("an idle lead, reported by the status hook", () => {
  test.use(seed("lead-idle-hook"));

  test("is not waiting for you and gets the next round", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("ANSWERED lead-idle-hook");
    await expect.poll(() => countMatches(lead(), /Aya round \d+: no progress since/g), { timeout: TEAM_CLOCK_TIMEOUT_MS }).toBeGreaterThanOrEqual(2);
    await expect(card.getByLabel("ux-review lead waiting")).toHaveCount(0);
    await expect(card.getByLabel("tester status")).not.toContainText("waiting for you");
    expect(skipLines(seeded.ayaHome)).toEqual([]);
  });
});

test.describe("a lead that asked the user", () => {
  test.use(seed("lead-waits"));

  test("gets no more rounds, and the team log says each was skipped for its question", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("ANSWERED lead-waits");
    await expect(card.getByLabel("ux-review lead waiting")).toHaveText(/tester is waiting for you since \d\d:\d\d: need the staging password/);
    await expect.poll(() => skipLines(seeded.ayaHome), { timeout: TEAM_CLOCK_TIMEOUT_MS }).toEqual(["tester: Aya round 2 skipped: tester asked the user: need the staging password"]);
    await window.waitForTimeout(QUIET_NO_ROUND_MS);
    expect(countMatches(lead(), /Aya round \d+: no progress since/g)).toBe(1);
    expect(skipLines(seeded.ayaHome)).toEqual(["tester: Aya round 2 skipped: tester asked the user: need the staging password"]);
  });
});

test.describe("a lead waiting on a teammate (aya status waiting --on)", () => {
  test.use(seed("lead-waits-on"));

  test("is not waiting for you: its row names the teammate, no attention, and the rounds go on", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("ANSWERED lead-waits-on");
    await expect(card.getByLabel("tester status")).toHaveText(/waiting on implementer since \d\d:\d\d/);
    await expect(card.getByLabel("ux-review lead waiting")).toHaveCount(0);
    await expect(window.locator(".aya-status-rail-row--waiting")).toHaveCount(0);
    await expect.poll(() => countMatches(lead(), /Aya round \d+: no progress since/g), { timeout: TEAM_CLOCK_TIMEOUT_MS }).toBeGreaterThanOrEqual(2);
    expect(lead()).toMatch(/Said they wait \(aya status\): tester on implementer since/);
    expect(skipLines(seeded.ayaHome)).toEqual([]);
  });
});

test.describe("a lead that asked the user, then shows a permission dialog", () => {
  test.use(seed("lead-waits-dialog"));

  test("the Enter that answers the dialog is not the answer to the question", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = () => dialog.getByTestId("team-ux-review");
    const lead = () => teamLog(seeded.projectDir)("tab-left");
    await expect.poll(() => lead(), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toContain("ANSWERED lead-waits-dialog");
    await expect(card().getByLabel("ux-review lead waiting")).toHaveText(/tester is waiting for you since \d\d:\d\d: need the staging password/);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    await window.keyboard.press("Enter");
    await expect.poll(() => lead(), { timeout: TYPED_TIMEOUT_MS }).toContain("DIALOG-ANSWERED");
    await window.getByTestId("teams-toggle").click();
    await expect(card().getByLabel("ux-review lead waiting")).toHaveText(/tester is waiting for you since \d\d:\d\d: need the staging password/);
    // The answer itself, typed at the composer, ends it.
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await window.keyboard.type("the password is hunter2");
    await window.keyboard.press("Enter");
    await expect.poll(() => lead(), { timeout: TYPED_TIMEOUT_MS }).toContain("the password is hunter2");
    await window.getByTestId("teams-toggle").click();
    await expect(card().getByLabel("ux-review lead waiting")).toHaveCount(0);
  });
});
