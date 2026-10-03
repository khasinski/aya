// The team lead in the Teams window: the editor asks for one, a saved team
// without one says so, and picking one writes it to the repo file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { TWO_ROLE_TEAM, openNewTeam, openTeams, teamSeed } from "./helpers/team";

const repoFile = (projectDir: string, name: string) => join(projectDir, ".aya", "teams", `${name}.md`);

test("the template's lead is its first role; Save is off while no lead is picked", async ({ window, seeded }) => {
  const dialog = await openNewTeam(window);
  await dialog.getByLabel("Team name").fill("duo");
  const lead = dialog.getByLabel("Lead role");
  const save = dialog.getByRole("button", { name: "Save team" });
  await expect(lead.locator("option:checked")).toHaveText("reviewer");
  await lead.selectOption({ label: "Pick the lead" });
  await expect(dialog.getByText(/Pick the role that leads the team/)).toBeVisible();
  await expect(save).toBeDisabled();
  await lead.selectOption({ label: "implementer" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog.getByTestId("team-duo")).toBeVisible();
  expect(readFileSync(repoFile(seeded.projectDir, "duo"), "utf8")).toMatch(/## Lead\nimplementer\n/);
  await expect(dialog.getByLabel("implementer leads")).toBeVisible();
  await expect(dialog.getByLabel("reviewer leads")).toHaveCount(0);
});

test("removing the lead's role clears the pick, and Save asks for another", async ({ window }) => {
  const dialog = await openNewTeam(window);
  await dialog.getByLabel("Team name").fill("duo");
  await dialog.getByRole("button", { name: "Remove role 1" }).click();
  await expect(dialog.getByLabel("Lead role").locator("option:checked")).toHaveText("Pick the lead");
  await expect(dialog.getByRole("button", { name: "Save team" })).toBeDisabled();
});

test.describe("a team saved before leads", () => {
  test.use(teamSeed(TWO_ROLE_TEAM));

  test("it still loads and says to set a lead; Edit keeps it off until one is picked", async ({ window, seeded }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(card.getByText("no lead role: set one")).toBeVisible();
    await expect(card.getByLabel("tester leads")).toHaveCount(0);
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const save = dialog.getByRole("button", { name: "Save team" });
    await expect(save).toBeDisabled();
    await dialog.getByLabel("Lead role").selectOption({ label: "tester" });
    await save.click();
    await expect(card.getByLabel("tester leads")).toBeVisible();
    await expect(card.getByText("no lead role: set one")).toHaveCount(0);
    expect(readFileSync(repoFile(seeded.projectDir, "ux-review"), "utf8")).toMatch(/## Lead\ntester\n/);
  });
});
