// An agent defines a team through the real CLI and app: aya team new prints the
// guide, aya team save saves its example, and the open Teams window shows it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import { AYA, openTeams } from "./helpers/team";

test("a team saved with aya team save shows in the open Teams window, saved and startable", async ({ window, seeded }) => {
  const dialog = await openTeams(window);
  const env = { ...envWithoutAya(), AYA_SOCKET: join(seeded.ayaHome, "aya.sock"), AYA_TERMINAL_ID: "tab-left" };
  const aya = (args: string[], input?: string) => spawnSync(AYA, ["team", ...args], { env, input, encoding: "utf8" });

  const guide = aya(["new", "a team that reviews and fixes UX"]);
  expect(guide.status).toBe(0);
  expect(guide.stdout).toMatch(/^The user asked for: a team that reviews and fixes UX\n/);
  const file = guide.stdout.split(/^----- .* -----$/m)[1];

  const broken = aya(["save", "-"], file.replace("Must not: edit code\n", ""));
  expect(broken.status).toBe(1);
  expect(broken.stderr).toBe('aya: team "ux-fix": role "reviewer" needs a "Must not:" line\n');
  expect(existsSync(join(seeded.projectDir, ".aya", "teams", "ux-fix.md"))).toBe(false);

  const saved = aya(["save", "-"], file);
  expect(saved.stderr).toBe("");
  expect(saved.stdout).toMatch(/^saved team ux-fix: 3 roles \(reviewer, fixer, tester\); reviewer -> fixer /);
  expect(existsSync(join(seeded.ayaHome, "teams", "e2e-proj", "ux-fix", "saved.md"))).toBe(true);
  const card = dialog.getByTestId("team-ux-fix");
  await expect(card).toBeVisible();
  await expect(card.getByText("must not edit code")).toBeVisible();
  await expect(card.getByText(/not saved in Aya yet/)).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Start", exact: true })).toBeVisible();

  const again = aya(["save", "-"], file);
  expect(again.status).toBe(1);
  expect(again.stderr).toMatch(/already exists .*--replace/);
});
