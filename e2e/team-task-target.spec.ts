// The Task field of the Teams window names who gets the task before Start, and a small
// select picks another role. The lead is the default, and the role with the rounds is the lead.

import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamSeed, HANDOFF_TEAM, START_REPLY_TIMEOUT_MS } from "./helpers/team";

const TEAM = `${HANDOFF_TEAM}\n## Lead\nimplementer\n\n## Cadence\nimplementer every 2 min\n`;

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
    await expect(card.getByLabel("ux-review status")).toHaveText("not started - the lead gets a round every 2 min");
    await startTask(card, "retest the login");
    await expect(card.getByLabel("ux-review status")).toContainText("the lead gets a round every 2 min");
  });

  test("the field names the lead before Start; with no pick the lead gets the task", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(card.getByLabel("Task for ux-review")).toHaveAttribute("placeholder", "Task for implementer (the lead)");
    await expect(card.getByLabel("Task goes to for ux-review").locator("option:checked")).toHaveText("lead");
    await startTask(card, "retest the login");
    await expect(card.getByText("Started; task sent to implementer.")).toBeVisible();
    // Info, not an error: it reads in the secondary text color, not the danger red.
    const color = (value: string) =>
      window.evaluate((v) => {
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.color = v;
        const rgb = getComputedStyle(probe).color;
        probe.remove();
        return rgb;
      }, value);
    expect(await color("var(--fg-secondary)")).not.toBe(await color("var(--danger, #c0392b)"));
    await expect(card.getByLabel("ux-review note")).toHaveCSS("color", await color("var(--fg-secondary)"));
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
