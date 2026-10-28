import { closeAndWait, expect, launchApp, test } from "./fixtures";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { envWithoutAya } from "./helpers/env";
import { AYA, LEAD_TEAM, openTeams, teamSeed } from "./helpers/team";

const TEAM_POLL_INTERVAL_MS = 5_000;

const SOURCES = [
  ["repo-only", { repoDefined: true, savedInAya: false }],
  ["Aya-home-only", { repoDefined: false, savedInAya: true }],
  ["both", { repoDefined: true, savedInAya: true }],
] as const;

for (const [source, options] of SOURCES) {
  test.describe(`team assignment prompt removed (${source})`, () => {
    test.use(teamSeed(LEAD_TEAM, { assignments: null, ...options }));

    test("stays absent on open, restart, Teams save, user CLI save, and agent CLI save", async ({ app, window, seeded }) => {
      const expectNoPromptAfterSettledTeams = async (page: typeof window) => {
        await page.waitForTimeout(TEAM_POLL_INTERVAL_MS + 100);
        await expect(page.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
        let teams = await openTeams(page);
        await expect(teams.getByTestId("team-ux-review")).toBeVisible();
        await teams.getByRole("button", { name: "Close" }).click();
        await page.waitForTimeout(TEAM_POLL_INTERVAL_MS + 100);
        await expect(page.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
        // Closing used to run the delayed assignment-prompt path. Reopen and
        // wait for the refreshed list before the final absence assertion.
        teams = await openTeams(page);
        await expect(teams.getByTestId("team-ux-review")).toBeVisible();
        await teams.getByRole("button", { name: "Close" }).click();
        await page.waitForTimeout(TEAM_POLL_INTERVAL_MS + 100);
        await expect(page.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
      };
      await expectNoPromptAfterSettledTeams(window);

      await closeAndWait(app);
      const relaunched = await launchApp(seeded);
      const relaunchedWindow = await relaunched.firstWindow();
      try {
        await expectNoPromptAfterSettledTeams(relaunchedWindow);

        const teams = await openTeams(relaunchedWindow);
        const card = teams.getByTestId("team-ux-review");
        await expect(card).toBeVisible();
        await card.getByRole("button", { name: "Edit" }).click();
        const editor = teams.getByLabel("Protocol");
        await editor.fill("Saved in the Teams editor.");
        await teams.getByRole("button", { name: "Save team" }).click();
        await expect(card).toBeVisible();
        await expect(relaunchedWindow.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);

        const save = (agent: boolean) => spawnSync(AYA, ["team", "save", "--replace", "-"], {
          cwd: seeded.projectDir,
          env: {
            ...envWithoutAya(),
            AYA_SOCKET: join(seeded.ayaHome, "aya.sock"),
            ...(agent ? { AYA_TERMINAL_ID: seeded.tabIds.left } : {}),
          },
          input: LEAD_TEAM,
          encoding: "utf8",
        });
        const userSave = save(false);
        expect(userSave.status, userSave.stderr).toBe(0);
        expect(userSave.stdout).toContain("roles without a pane: tester, implementer;");
        expect(userSave.stdout).toContain("aya team open ux-review tester=<pane or preset> implementer=<pane or preset>");
        await expect(relaunchedWindow.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);

        const agentSave = save(true);
        expect(agentSave.status, agentSave.stderr).toBe(0);
        expect(agentSave.stdout).toContain("roles without a pane: tester, implementer;");
        expect(agentSave.stdout).toContain("aya team open ux-review tester=<pane or preset> implementer=<pane or preset>");
        await expect(relaunchedWindow.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
        await expect(card).toBeVisible();
        await teams.getByRole("button", { name: "Close" }).click();
        const settledTeams = await openTeams(relaunchedWindow);
        await expect(settledTeams.getByTestId("team-ux-review")).toBeVisible();
        await settledTeams.getByRole("button", { name: "Close" }).click();
        await expect(relaunchedWindow.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
      } finally {
        await closeAndWait(relaunched);
      }
    });
  });
}

test.describe("a project with no team", () => {
  test.use(teamSeed(LEAD_TEAM, { repoDefined: false, savedInAya: false, assignments: null }));

  test("has no assignment prompt on open or restart", async ({ app, window, seeded }) => {
    const settleTeams = async (page: typeof window) => {
      await page.waitForTimeout(TEAM_POLL_INTERVAL_MS + 100);
      await expect(page.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
      let teams = await openTeams(page);
      await expect(teams.getByText("No team yet.")).toBeVisible();
      await teams.getByRole("button", { name: "Close" }).click();
      await page.waitForTimeout(TEAM_POLL_INTERVAL_MS + 100);
      await expect(page.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
      teams = await openTeams(page);
      await expect(teams.getByText("No team yet.")).toBeVisible();
      await teams.getByRole("button", { name: "Close" }).click();
      await page.waitForTimeout(TEAM_POLL_INTERVAL_MS + 100);
      await expect(page.getByRole("dialog", { name: "Assign team roles" })).toHaveCount(0);
    };
    await settleTeams(window);
    await closeAndWait(app);
    const relaunched = await launchApp(seeded);
    try {
      const relaunchedWindow = await relaunched.firstWindow();
      await settleTeams(relaunchedWindow);
    } finally {
      await closeAndWait(relaunched);
    }
  });
});
