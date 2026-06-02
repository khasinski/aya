import { test, expect } from "./fixtures";

test("launches the built app and hydrates the seeded split project", async ({ window }) => {
  // Two panes from the seeded 1x2 split layout prove: window opened, renderer
  // booted, project loaded, terminals hydrated, split rendered.
  await expect(window.locator(".aya-pane")).toHaveCount(2);

  // The project's terminal names came from the seeded config.
  await expect(window.locator(".aya-pane-header-title").first()).toHaveText("shell 1");
});
