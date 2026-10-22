// `aya pane rename` from the real CLI into the real app: the window renames the tab, saves it
// before the CLI returns, and keeps the split. The seed stores the legacy grid, which only a
// save through persistProject turns into a split tree; a save that skips it loses the split.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeAndWait } from "./fixtures";
import { trackLaunches } from "./helpers/relaunch";

const launches = trackLaunches();
const AYA_CLI = join(__dirname, "..", "bin", "aya");

function aya(ayaHome: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AYA_"))) as Record<string, string>;
  return execFileSync(AYA_CLI, args, { env: { ...env, AYA_HOME: ayaHome }, encoding: "utf8", timeout: 20_000 });
}

const savedProject = (ayaHome: string) => JSON.parse(readFileSync(join(ayaHome, "projects", "e2e-proj.json"), "utf8"));

test("a CLI rename is saved before the CLI returns and keeps the split after a relaunch", async ({ app, window, seeded }) => {
  const panes = '[data-testid="terminal-pane"]';
  await expect(window.locator(panes)).toHaveCount(2);

  expect(aya(seeded.ayaHome, ["pane", "rename", "shell 2", "auth fix"])).toBe("renamed shell 2 to auth fix\n");
  expect(aya(seeded.ayaHome, ["pane", "list"])).toContain("auth fix");
  const saved = savedProject(seeded.ayaHome);
  expect(saved.tabs.map((t: { name: string }) => t.name)).toEqual(["shell 1", "auth fix"]);
  expect(saved.splitTree, "the save wrote the split as a tree").toBeTruthy();
  await expect(window.locator(`[data-testid="sidebar-terminal"][data-terminal-id="${seeded.tabIds.right}"]`)).toHaveAttribute("data-terminal-name", "auth fix");

  await closeAndWait(app);
  const again = await launches.launch(seeded);
  await expect(again.window.locator(`${panes}:visible`)).toHaveCount(2);
});
