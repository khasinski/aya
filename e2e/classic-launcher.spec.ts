import { test, expect } from "./fixtures";

// The classic Sidebar "New terminal" launcher spawns a terminal for the clicked
// preset. (The projects-left "+" launcher is covered; the classic sidebar
// launcher click was not - path-repair only checked button visibility.)

test("clicking a sidebar preset launches a new terminal for that preset (classic)", async ({
  window,
}) => {
  await expect(window.getByTestId("sidebar-terminal")).toHaveCount(2);

  await window.locator(".aya-launcher .aya-launcher-btn", { hasText: "Shell" }).click();

  await expect(window.getByTestId("sidebar-terminal")).toHaveCount(3);
  // The new terminal is named after the "Shell" preset and becomes the active
  // row - "Shell" (capitalised) is distinct from the seeded "shell 1"/"shell 2".
  const active = window.locator(".aya-sidebar-row--active");
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("data-terminal-name", "Shell");
});
