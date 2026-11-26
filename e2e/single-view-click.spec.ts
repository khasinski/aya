import { test, expect, launchApp, closeAndWait } from "./fixtures";
import { seedEnv } from "./helpers/seed";
import { sidebarRow } from "./helpers/sidebar";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A pane picked from the sidebar while the project has a split, but which is not in it, shows on its own (single
// view). A click inside it, as on an approval's Allow once or in its terminal, reverted to the split and hid it
// (2026-11-26: a Send to several agents Claude pane vanished on every click, its approval never answered).
test("a pane shown on its own stays when clicked", async () => {
  const seed = seedEnv();
  const file = join(seed.ayaHome, "projects", "e2e-proj.json");
  const project = JSON.parse(readFileSync(file, "utf8"));
  project.tabs.push({ id: "tab-third", presetId: "shell", name: "shell 3" });
  writeFileSync(file, JSON.stringify(project, null, 2));
  const app = await launchApp(seed);
  try {
    const window = await app.firstWindow();
    const pane = (name: string) => window.locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]`);
    await expect(pane("shell 1")).toBeVisible();
    await expect(pane("shell 2")).toBeVisible();

    await sidebarRow(window, "shell 3").click();
    await expect(pane("shell 3")).toBeVisible();
    await expect(pane("shell 1")).toBeHidden();

    await pane("shell 3").locator(".aya-xterm-host").click();
    await window.waitForTimeout(300);
    await expect(pane("shell 3")).toBeVisible();
    await expect(pane("shell 1")).toBeHidden();

    // Picking a pane of the split from the sidebar still goes back to the split.
    await sidebarRow(window, "shell 1").click();
    await expect(pane("shell 1")).toBeVisible();
    await expect(pane("shell 2")).toBeVisible();
    await expect(pane("shell 3")).toBeHidden();
  } finally {
    await closeAndWait(app);
    rmSync(seed.root, { recursive: true, force: true });
  }
});
