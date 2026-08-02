import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// Hot-reload of externally-edited project configs (#4). The watcher on
// AYA_HOME/projects pushes a "projects" config-changed event; the renderer
// merges disk state in WITHOUT touching live terminals. The project NAME in
// the top bar doubles as the "reload landed" observable in every test, so no
// sleeps are needed - each assertion waits on the visible effect itself.
//
// The invariant behind all three tests (maintainer decision on #4): editing a
// file must never unexpectedly kill running terminals.

function projectFile(ayaHome: string): string {
  return join(ayaHome, "projects", "e2e-proj.json");
}

function readProject(ayaHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(projectFile(ayaHome), "utf8"));
}

// Plain (non-atomic) write - exactly what an external editor does.
function writeProject(ayaHome: string, config: Record<string, unknown>): void {
  writeFileSync(projectFile(ayaHome), JSON.stringify(config, null, 2) + "\n");
}

test("external tab rename shows up in the sidebar without a restart", async ({
  window,
  seeded,
}) => {
  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 2" }),
  ).toBeVisible();

  const config = readProject(seeded.ayaHome);
  config.name = "e2e renamed";
  (config.tabs as Array<{ name: string }>)[1].name = "renamed outside";
  writeProject(seeded.ayaHome, config);

  // Project name change proves the reload reached the renderer...
  await expect(window.locator(".aya-tab-name")).toHaveText("e2e renamed");
  // ...and the live terminal's row now carries the externally-edited name.
  await expect(
    window.locator(".aya-sidebar-row", { hasText: "renamed outside" }),
  ).toBeVisible();
  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 2" }),
  ).toHaveCount(0);
});

test("a tab removed on disk keeps its live terminal row (#4 decision 1)", async ({
  window,
  seeded,
}) => {
  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 2" }),
  ).toBeVisible();

  const config = readProject(seeded.ayaHome);
  config.name = "e2e shrunk";
  config.tabs = [(config.tabs as unknown[])[0]];
  // Keep the file self-consistent: the split no longer references the removed tab.
  delete config.splitLayout;
  writeProject(seeded.ayaHome, config);

  await expect(window.locator(".aya-tab-name")).toHaveText("e2e shrunk");
  // The removed-from-disk tab still has a live PTY -> its row must survive.
  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 2" }),
  ).toBeVisible();
  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 1" }),
  ).toBeVisible();
});

test("a tab added on disk appears in the sidebar without spawning (#4 decision 2)", async ({
  window,
  seeded,
}) => {
  // Gate on boot having hydrated the ORIGINAL 2-tab config: writing earlier
  // would race bootstrap, which would then hydrate (and spawn) the third tab
  // as if it had been there all along.
  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 2" }),
  ).toBeVisible();

  const config = readProject(seeded.ayaHome);
  config.name = "e2e grown";
  (config.tabs as unknown[]).push({
    id: "tab-added",
    presetId: "shell",
    name: "added outside",
  });
  writeProject(seeded.ayaHome, config);

  await expect(window.locator(".aya-tab-name")).toHaveText("e2e grown");
  const addedRow = window.locator(".aya-sidebar-row", {
    hasText: "added outside",
  });
  await expect(addedRow).toBeVisible();
  // No PTY was spawned: the dot stays idle until the user activates the tab.
  await expect(addedRow.locator(".aya-sidebar-statusdot")).toHaveClass(
    /aya-sidebar-statusdot--idle/,
  );

  // Activation is what starts the process: select the tab and the spawned
  // shell's output flips the dot to running.
  await addedRow.click();
  await expect(addedRow.locator(".aya-sidebar-statusdot")).toHaveClass(
    /aya-sidebar-statusdot--running/,
  );
});
