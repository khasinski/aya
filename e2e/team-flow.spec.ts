// Flow preview in Define team: drawn from the Sends to boxes and the what typed
// for each route, live, with no model.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { openTeams } from "./helpers/team";

async function editor(window: Page) {
  const dialog = await openTeams(window);
  await dialog.getByRole("button", { name: "New team" }).click();
  return dialog;
}

test("the graph and routes follow the Sends to boxes as you tick them", async ({ window }) => {
  const dialog = await editor(window);
  const routes = dialog.getByLabel("Flow routes");
  await expect(routes).toContainText("reviewer → implementer: findings with the screen state as proof");
  await expect(routes).toContainText("implementer → reviewer: answers and the commit to check");
  await expect(dialog.getByRole("img", { name: "Team flow: reviewer to implementer, implementer to reviewer" })).toBeVisible();
  await dialog.getByLabel("Role 2 sends to reviewer").uncheck();
  await expect(routes).not.toContainText("implementer → reviewer");
  await expect(dialog.getByRole("img", { name: "Team flow: reviewer to implementer" })).toBeVisible();
});

test("the what typed for a route labels it, and Save writes it into the team file", async ({ window, seeded }) => {
  const dialog = await editor(window);
  await dialog.getByRole("button", { name: "Add role" }).click();
  await dialog.getByLabel("Role 3 name").fill("tester");
  await dialog.getByLabel("Role 3 must not").fill("fix bugs itself");
  await dialog.getByLabel("Role 3 sends to reviewer").check();
  const routes = dialog.getByLabel("Flow routes");
  await expect(routes).toContainText("tester → reviewer: what it sends is not filled in");
  await dialog.getByLabel("What goes from role 3 to reviewer").fill("measured results (pass or fail)");
  await expect(routes).toContainText("tester → reviewer: measured results pass or fail");
  await dialog.getByLabel("Role 1 sends to tester").check();
  await dialog.getByLabel("What goes from role 1 to tester").fill("measurement requests");
  await dialog.getByLabel("Team name").fill("trio");
  await dialog.getByRole("button", { name: "Save team" }).click();
  await expect(dialog.getByTestId("team-trio")).toBeVisible();
  const saved = readFileSync(join(seeded.projectDir, ".aya", "teams", "trio.md"), "utf8");
  expect(saved).toContain("Sends to: implementer (findings with the screen state as proof), tester (measurement requests)");
  expect(saved).toContain("## Role: tester\nSends to: reviewer (measured results pass or fail)");
});

test("a role nobody sends to, or that sends to nobody, is flagged", async ({ window }) => {
  const dialog = await editor(window);
  await dialog.getByRole("button", { name: "Add role" }).click();
  await dialog.getByLabel("Role 3 name").fill("tester");
  await dialog.getByLabel("Round role").selectOption("implementer");
  // team1 as saved by hand: reviewer -> tester, implementer -> reviewer, tester -> reviewer.
  await dialog.getByLabel("Role 1 sends to implementer").uncheck();
  await dialog.getByLabel("Role 1 sends to tester").check();
  await dialog.getByLabel("Role 3 sends to reviewer").check();
  const warnings = dialog.locator(".aya-teams-flow .aya-teams-warning");
  await expect(warnings).toHaveText(["Nobody sends to implementer; it only gets Aya's rounds."]);
  await dialog.getByLabel("Role 3 sends to reviewer").uncheck();
  await expect(warnings).toContainText(["tester sends to nobody, so its work reaches no one."]);
});
