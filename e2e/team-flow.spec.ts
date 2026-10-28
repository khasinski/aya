// Flow preview in Define team: drawn from the Sends to boxes and the what typed
// for each route, live, with no model.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import { agentPreset, AYA, LEAD_TEAM, openNewTeam, openTeams, teamSeed, TEAM_STATE_DIR } from "./helpers/team";

test("the graph and routes follow the Sends to boxes as you tick them", async ({ window }) => {
  const dialog = await openNewTeam(window);
  const routes = dialog.getByLabel("Flow routes");
  await expect(routes).toContainText("reviewer → implementer: findings with the screen state as proof");
  await expect(routes).toContainText("implementer → reviewer: answers and the commit to check");
  await expect(dialog.getByRole("img", { name: "Team flow: reviewer to implementer, implementer to reviewer" })).toBeVisible();
  await dialog.getByLabel("Role 2 sends to reviewer").uncheck();
  await expect(routes).not.toContainText("implementer → reviewer");
  await expect(dialog.getByRole("img", { name: "Team flow: reviewer to implementer" })).toBeVisible();
});

test("the what typed for a route labels it, and Save writes it into the team file", async ({ window, seeded }) => {
  const dialog = await openNewTeam(window);
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
  const card = dialog.getByTestId("team-trio");
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport();
  const firstRolePane = card.getByLabel("Pane for reviewer");
  await expect.poll(() => firstRolePane.evaluate((element) => element === document.activeElement)).toBe(true);
  const saved = readFileSync(join(seeded.projectDir, ".aya", "teams", "trio.md"), "utf8");
  expect(saved).toContain("Sends to: implementer (findings with the screen state as proof), tester (measurement requests)");
  expect(saved).toContain("## Role: tester\nSends to: reviewer (measured results pass or fail)");

  await dialog.getByRole("button", { name: "New team" }).click();
  await dialog.getByLabel("Team name").fill("trio");
  await dialog.getByRole("button", { name: "Save team" }).click();
  await expect(dialog.getByLabel("Team name")).toBeVisible();
  await expect(dialog.locator(".aya-teams-error")).toContainText('team "trio" already exists');
});

test.describe("saving a team below the scroll fold", () => {
  const earlierTeams = Object.fromEntries(Array.from({ length: 14 }, (_, index) => {
    const name = `early-${String(index).padStart(2, "0")}`;
    return [`.aya/teams/${name}.md`, LEAD_TEAM.replace("# ux-review", `# ${name}`)];
  }));
  const lastName = "zzzz-last-team";
  const lastTeam = LEAD_TEAM.replace("# ux-review", `# ${lastName}`);
  test.use(teamSeed(lastTeam, {
    repoDefined: false,
    savedInAya: false,
    assignments: null,
    seed: { projectFiles: { ...earlierTeams, [`.aya/teams/${lastName}.md`]: lastTeam } },
    ayaHomeFiles: {
      [`${TEAM_STATE_DIR.replace("ux-review", lastName)}/saved.md`]: lastTeam,
      [`${TEAM_STATE_DIR.replace("ux-review", lastName)}/assignments.json`]: JSON.stringify({ tester: "tab-left", implementer: "tab-right" }),
    },
  }));

  test("Save scrolls an edited, fully assigned card into view", async ({ window }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId(`team-${lastName}`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Edit" }).click();
    await dialog.getByRole("button", { name: "Save team" }).click();
    await expect(card).toBeVisible();
    await expect(card).toBeInViewport({ ratio: 1 });
  });
});

test("a role nobody sends to, or that sends to nobody, is flagged", async ({ window }) => {
  const dialog = await openNewTeam(window);
  await dialog.getByRole("button", { name: "Add role" }).click();
  await dialog.getByLabel("Role 3 name").fill("tester");
  // The rounds go to the lead: leading makes the implementer the role that only gets Aya's rounds.
  await dialog.getByLabel("Lead role").selectOption({ label: "implementer" });
  // team1 as saved by hand: reviewer -> tester, implementer -> reviewer, tester -> reviewer.
  await dialog.getByLabel("Role 1 sends to implementer").uncheck();
  await dialog.getByLabel("Role 1 sends to tester").check();
  await dialog.getByLabel("Role 3 sends to reviewer").check();
  const warnings = dialog.locator(".aya-teams-flow .aya-teams-warning");
  await expect(warnings).toHaveText(["Nobody sends to implementer; it only gets Aya's rounds."]);
  await dialog.getByLabel("Role 3 sends to reviewer").uncheck();
  await expect(warnings).toContainText(["tester sends to nobody, so its work reaches no one."]);
});

test.describe("editing a saved team", () => {
  test.use(teamSeed(LEAD_TEAM));

  test("after adding a role, Save returns with its Pane select focused", async ({ window }) => {
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Edit" }).click();
    await dialog.getByRole("button", { name: "Add role" }).click();
    await dialog.getByLabel("Role 3 name").fill("auditor");
    await dialog.getByLabel("Role 3 must not").fill("edit code");
    await dialog.getByLabel("Role 3 responsibilities").fill("Checks the change.");
    await dialog.getByRole("button", { name: "Save team" }).click();

    const savedCard = dialog.getByTestId("team-ux-review");
    await expect(savedCard).toBeVisible();
    await expect(savedCard).toBeInViewport();
    const newRolePane = savedCard.getByLabel("Pane for auditor");
    await expect.poll(() => newRolePane.evaluate((element) => element === document.activeElement)).toBe(true);
  });
});

test.describe("editing a team with an exited assigned pane", () => {
  const exited = agentPreset("exit", "claude");
  test.use(teamSeed(LEAD_TEAM, {
    assignments: { tester: "tab-right", implementer: "tab-left" },
    presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }, { ...exited, id: "exited", name: "Exited agent" }],
    seed: { rightTab: { presetId: "exited", name: "Exited agent" } },
  }));

  test("CLI save sees an exited assigned tab as unassigned, and Save focuses its Pane select", async ({ window, seeded }) => {
    const pane = window.locator(".aya-pane").filter({ hasText: "Exited agent" });
    await expect(pane).toContainText(/process exited/i, { timeout: 10_000 });
    const cliSave = spawnSync(AYA, ["team", "save", "--replace", "-"], {
      cwd: seeded.projectDir,
      env: { ...envWithoutAya(), AYA_SOCKET: join(seeded.ayaHome, "aya.sock") },
      input: LEAD_TEAM,
      encoding: "utf8",
    });
    expect(cliSave.status, cliSave.stderr).toBe(0);
    expect(cliSave.stdout).toContain("roles without a pane: tester;");
    expect(cliSave.stdout).not.toContain("roles without a pane: tester, implementer;");
    const dialog = await openTeams(window);
    const card = dialog.getByTestId("team-ux-review");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Edit" }).click();
    await dialog.getByRole("button", { name: "Save team" }).click();
    const paneSelect = dialog.getByTestId("team-ux-review").getByLabel("Pane for tester");
    await expect.poll(() => paneSelect.evaluate((element) => element === document.activeElement)).toBe(true);
  });
});
