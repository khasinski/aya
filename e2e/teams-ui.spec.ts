// The teams window, through the real app: define a team from the template,
// assign panes, start it, pause it, and adopt a changed repo file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { LAYOUT_MODE_STORAGE_KEY } from "../src/storage-keys";
import { TEAM_AGENT_READY_TIMEOUT_MS, TEAM_DELIVERY_TIMEOUT_MS, agentPreset, openTeams, teamLog, teamLogFile } from "./helpers/team";

test.use({ seedOptions: { presetList: [agentPreset("quiet", "claude")] } });

async function defineFromTemplate(window: Page, name: string) {
  const dialog = await openTeams(window);
  await dialog.getByRole("button", { name: "New team" }).click();
  await dialog.getByLabel("Team name").fill(name);
  await dialog.getByRole("button", { name: "Save team" }).click();
  await expect(dialog.getByTestId(`team-${name}`)).toBeVisible();
  return dialog;
}

test("New team from the template writes the repo file", async ({ window, seeded }) => {
  await defineFromTemplate(window, "ux-review");
  const file = join(seeded.projectDir, ".aya", "teams", "ux-review.md");
  expect(readFileSync(file, "utf8")).toMatch(/## Role: reviewer\nSends to: implementer \(findings with the screen state as proof\)\nMust not: edit code/);
});

test("a role without must-not is refused with the reason, and nothing is written", async ({ window, seeded }) => {
  const dialog = await openTeams(window);
  await dialog.getByRole("button", { name: "New team" }).click();
  await dialog.getByLabel("Team name").fill("broken");
  await dialog.getByLabel("Role 1 must not").fill("");
  await dialog.getByRole("button", { name: "Save team" }).click();
  await expect(dialog.getByText(/needs a "Must not:" line/)).toBeVisible();
  expect(existsSync(join(seeded.projectDir, ".aya", "teams", "broken.md"))).toBe(false);
});

test("assign panes, Start sends the delivery test, Pause marks the team, Resume clears it", async ({ window, seeded }) => {
  const dialog = await defineFromTemplate(window, "ux-review");
  const card = dialog.getByTestId("team-ux-review");
  await card.getByLabel("Pane for reviewer").selectOption({ label: "shell 1" });
  const file = (pane: string) => teamLogFile(seeded.projectDir, pane);
  const log = teamLog(seeded.projectDir);
  // Each agent creates its log on start; Start before that finds it still starting.
  await expect.poll(() => existsSync(file("tab-left")) && existsSync(file("tab-right")), { timeout: TEAM_AGENT_READY_TIMEOUT_MS }).toBe(true);
  // One role without a pane: Start sends nothing to anyone and says why.
  await card.getByRole("button", { name: "Start", exact: true }).click();
  await expect(card.locator(".aya-teams-warning")).toContainText("Not started, nothing was sent");
  await expect(card.getByRole("status", { name: "implementer not reached" })).toHaveText("⚠ Not reached: no pane assigned");
  await expect(card.getByRole("status", { name: "reviewer not reached" })).toHaveCount(0);
  await expect(card.getByLabel("ux-review messages")).toHaveCount(0);
  await card.getByLabel("Pane for implementer").selectOption({ label: "shell 2" });
  await expect(card.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => log("tab-left"), { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toMatch(/Delivery test/);
  await expect(card.getByLabel("ux-review messages")).toContainText("aya → implementer");
  // A pane given a role while the team runs is told its role at once.
  const before = log("tab-right").match(/Delivery test/g)?.length ?? 0;
  await card.getByLabel("Pane for implementer").selectOption({ label: "No pane" });
  await card.getByLabel("Pane for implementer").selectOption({ label: "shell 2" });
  await expect.poll(() => log("tab-right").match(/Delivery test/g)?.length ?? 0, { timeout: TEAM_DELIVERY_TIMEOUT_MS }).toBe(before + 1);
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(card.getByText("paused", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(card.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(card.getByText("paused", { exact: true })).toHaveCount(0);
});

test("a repo edit shows as changed and can be adopted", async ({ window, seeded }) => {
  const dialog = await defineFromTemplate(window, "ux-review");
  const file = join(seeded.projectDir, ".aya", "teams", "ux-review.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("Must not: edit code", "Must not: touch the database"));
  const card = dialog.getByTestId("team-ux-review");
  await expect(card.getByText(/repo file changed/)).toBeVisible();
  await card.getByRole("button", { name: "Use the repo version" }).click();
  await expect(card.getByText("must not touch the database")).toBeVisible();
  await expect(card.getByText(/repo file changed/)).toHaveCount(0);
});

test.describe("experimental layout", () => {
  test("the teams button opens the same window", async ({ window }) => {
    await window.evaluate((k) => localStorage.setItem(k, "projects-left"), LAYOUT_MODE_STORAGE_KEY);
    await window.reload();
    const dialog = await openTeams(window);
    await expect(dialog.getByRole("button", { name: "New team" })).toBeVisible();
  });
});
