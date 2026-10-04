// The Task field of the Teams window names who gets the task before Start, and a small
// select picks another role. The lead is the default, and the role with the rounds is the lead.

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { TEAM_STATE_DIR, TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamSeed, HANDOFF_TEAM, START_REPLY_TIMEOUT_MS } from "./helpers/team";

const CADENCE_MIN = 2;
const TEAM = `${HANDOFF_TEAM}\n## Lead\nimplementer\n\n## Cadence\nimplementer every ${CADENCE_MIN} min\n`;
const RHYTHM = `the lead gets a round every ${CADENCE_MIN} min`;

/** The note color as computed, checked to differ from the danger red so a match means neutral. */
async function neutralColor(window: Page): Promise<string> {
  const color = (value: string) =>
    window.evaluate((v) => {
      const probe = document.body.appendChild(document.createElement("span"));
      probe.style.color = v;
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    }, value);
  const neutral = await color("var(--fg-secondary)");
  expect(neutral).not.toBe(await color("var(--danger, #c0392b)"));
  return neutral;
}

test.describe("a team led by the implementer, who also has the rounds", () => {
  test.use(teamSeed(TEAM, { presetList: [agentPreset("quiet", "claude")] }));

  async function startTask(card: Locator, task: string, to?: string) {
    await card.getByLabel("Task for ux-review").fill(task);
    if (to) await card.getByLabel("Task goes to for ux-review").selectOption({ label: to });
    const start = card.getByRole("button", { name: "Start", exact: true });
    // Start refuses until every agent has drawn its composer: press it again until it took.
    await expect(async () => {
      if (await start.isVisible()) await start.click();
      await expect(card.getByText(/^Started;/)).toBeVisible({ timeout: START_REPLY_TIMEOUT_MS });
    }).toPass({ timeout: TEAM_AGENT_READY_TIMEOUT_MS });
  }

  test("the card names the cadence before Start, as the status line says it after", async ({ window }) => {
    const card = (await openTeams(window)).getByTestId("team-ux-review");
    await expect(card.getByLabel("ux-review status")).toHaveText(`not started - ${RHYTHM}`);
    await startTask(card, "retest the login");
    await expect(card.getByLabel("ux-review status")).toContainText(RHYTHM);
  });

  test("the field names the lead before Start; with no pick the lead gets the task", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(card.getByLabel("Task for ux-review")).toHaveAttribute("placeholder", "Task for implementer (the lead)");
    await expect(card.getByLabel("Task goes to for ux-review").locator("option:checked")).toHaveText("lead");
    await startTask(card, "retest the login");
    await expect(card.getByText("Started; task sent to implementer.")).toBeVisible();
    // Info, not an error: it reads in the secondary text color, not the danger red.
    await expect(card.getByLabel("ux-review note")).toHaveCSS("color", await neutralColor(window));
    await expect.poll(() => teamLog(seeded.projectDir)("tab-right"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/from user \| \d\d:\d\d\] retest the login/);
    expect(teamLog(seeded.projectDir)("tab-left")).not.toMatch(/retest the login/);
  });

  test("picking the tester changes the placeholder and sends the task there", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await card.getByLabel("Task goes to for ux-review").selectOption({ label: "tester" });
    await expect(card.getByLabel("Task for ux-review")).toHaveAttribute("placeholder", "Task for tester");
    await startTask(card, "check the build", "tester");
    await expect(card.getByText("Started; task sent to tester.")).toBeVisible();
    await expect.poll(() => teamLog(seeded.projectDir)("tab-left"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/from user \| \d\d:\d\d\] check the build/);
    expect(teamLog(seeded.projectDir)("tab-right")).not.toMatch(/check the build/);
  });
});

const STATUS_COMMAND = "echo gpu ok";
const TEAM_WITH_STATUS = `${TEAM}\n## Status command\n${STATUS_COMMAND}\n`;

test.describe("a team with a saved status command", () => {
  test.use(teamSeed(TEAM_WITH_STATUS, { presetList: [agentPreset("quiet", "claude")] }));

  test("the card names it in neutral text before Start", async ({ window }) => {
    const card = (await openTeams(window)).getByTestId("team-ux-review");
    const note = card.getByLabel("ux-review status command");
    await expect(note).toHaveText(`Status command, its output goes with the lead's rounds: ${STATUS_COMMAND}`);
    await expect(note).toHaveCSS("color", await neutralColor(window));
  });
});

test.describe("a repo version that brings a status command the saved team lacks", () => {
  test.use(teamSeed(TEAM_WITH_STATUS, { presetList: [agentPreset("quiet", "claude")], ayaHomeFiles: { [`${TEAM_STATE_DIR}/saved.md`]: TEAM } }));

  test("the card warns, not in neutral text, before the user saves it", async ({ window }) => {
    const card = (await openTeams(window)).getByTestId("team-ux-review");
    const note = card.getByLabel("ux-review status command");
    await expect(note).toHaveText(`Saving the repo version runs this status command each round, with your rights: ${STATUS_COMMAND}`);
    await expect(note).not.toHaveCSS("color", await neutralColor(window));
  });
});
