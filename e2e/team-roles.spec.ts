// Team roles on the tab lists (both layouts), the tab menu's Team role items,
// unread badges, and the prompt when a project brings a team with no panes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { TEAMS_REFRESH_MS } from "../src/hooks/useTeams";
import { LAYOUT_MODE_STORAGE_KEY } from "../src/storage-keys";

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;
const WAITING = `${JSON.stringify({ id: 1, time: new Date().toISOString(), from: "tester", to: "implementer", commit: null, text: "retest", delivered: false })}\n`;
const withTeam = (assignments: Record<string, string> | null, extra: Record<string, string> = {}) => ({
  seedOptions: {
    projectFiles: { ".aya/teams/ux-review.md": TEAM },
    ayaHomeFiles: {
      ...(assignments ? { "teams/e2e-proj/ux-review/assignments.json": JSON.stringify(assignments) } : {}),
      ...extra,
    },
  },
});

const ready = (window: Page) => expect(window.getByTestId("xterm-host").first()).toBeVisible();

test.describe("classic layout", () => {
  test.use(withTeam({ tester: "tab-left", implementer: "tab-right" }, { "teams/e2e-proj/ux-review/log.jsonl": WAITING }));

  test("rows show role, team and waiting messages", async ({ window }) => {
    await ready(window);
    const rows = window.locator(".aya-sidebar-row");
    await expect(rows.filter({ hasText: "shell 1" })).toContainText("tester · ux-review");
    await expect(rows.filter({ hasText: "shell 2" }).getByLabel("1 team messages waiting")).toBeVisible();
  });

  test("the tab menu moves a role to another pane", async ({ window, seeded }) => {
    await ready(window);
    const row = window.locator('.aya-sidebar-row[data-terminal-name="shell 2"]');
    await expect(row).toContainText("implementer");
    await row.click({ button: "right" });
    await window.locator(".aya-context-menu").getByText("Team role: ux-review › tester").click();
    const file = join(seeded.ayaHome, "teams", "e2e-proj", "ux-review", "assignments.json");
    await expect.poll(() => JSON.parse(readFileSync(file, "utf8"))).toEqual({ tester: "tab-right" });
    await expect(row).toContainText("tester · ux-review");
  });
});

test.describe("closing a tab", () => {
  test.use(withTeam({ tester: "tab-left", implementer: "tab-right" }));

  test("frees its role", async ({ window, seeded }) => {
    await ready(window);
    const row = window.locator('.aya-sidebar-row[data-terminal-name="shell 2"]');
    await expect(row).toContainText("implementer");
    await row.click({ button: "right" });
    await window.locator(".aya-context-menu").getByText("Close terminal").click();
    const file = join(seeded.ayaHome, "teams", "e2e-proj", "ux-review", "assignments.json");
    await expect.poll(() => JSON.parse(readFileSync(file, "utf8"))).toEqual({ tester: "tab-left" });
  });
});

test.describe("experimental layout", () => {
  test.use(withTeam({ tester: "tab-left", implementer: "tab-right" }, { "teams/e2e-proj/ux-review/log.jsonl": WAITING }));

  test("tabs show the role and the project rail sums waiting messages", async ({ window }) => {
    await window.evaluate((k) => localStorage.setItem(k, "projects-left"), LAYOUT_MODE_STORAGE_KEY);
    await window.reload();
    await ready(window);
    await expect(window.locator(".aya-termtab-main").filter({ hasText: "shell 1" })).toContainText("tester · ux-review");
    await expect(window.getByLabel("e2e team messages waiting")).toHaveText("✉ 1");
    const tab = window.locator(".aya-termtab-main").filter({ hasText: "shell 1" });
    await tab.click({ button: "right" });
    await expect(window.locator(".aya-context-menu").getByText("Remove team role")).toBeVisible();
  });
});

test.describe("a project that brings a team with no panes", () => {
  test.use(withTeam(null));

  test("offers to assign the roles; Open teams shows them", async ({ window }) => {
    await ready(window);
    const prompt = window.getByRole("dialog", { name: "Assign team roles" });
    await expect(prompt).toContainText("ux-review (tester, implementer)");
    await prompt.getByRole("button", { name: "Open teams" }).click();
    await expect(window.getByRole("dialog", { name: "Teams" }).getByTestId("team-ux-review")).toBeVisible();
  });

  test("Not now keeps it away for the session", async ({ window }) => {
    await ready(window);
    const prompt = window.getByRole("dialog", { name: "Assign team roles" });
    await prompt.getByRole("button", { name: "Not now" }).click();
    await expect(prompt).toHaveCount(0);
    // Long enough for a full teams refresh, which would bring the prompt back.
    await window.waitForTimeout(TEAMS_REFRESH_MS + 1_000);
    await expect(prompt).toHaveCount(0);
  });
});
