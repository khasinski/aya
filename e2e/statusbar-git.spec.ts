import { test, expect } from "./fixtures";

// StatusBar git surface: branch label, dirty count, the changed-files popover,
// the diff viewer, and in-diff search. Needs a real git repo (seed gitRepo).

test.use({ seedOptions: { gitRepo: true } });

test("StatusBar shows the branch, dirty count, changed files and a diff", async ({ window }) => {
  // Branch + dirty appear after the initial git read (polls every ~3s).
  await expect(window.locator(".aya-statusbar-item", { hasText: "feature/foo" })).toBeVisible({
    timeout: 10000,
  });
  const dirtyBtn = window.locator(".aya-statusbar-button", { hasText: "dirty" });
  await expect(dirtyBtn).toContainText("2 dirty", { timeout: 10000 });

  // Open the changed-files popover - both files listed (modified + untracked).
  await dirtyBtn.click();
  const popover = window.locator(".aya-statusbar-popover");
  await expect(popover).toBeVisible();
  await expect(popover.locator(".aya-dirty-file-row")).toHaveCount(2);
  await expect(
    popover.locator(".aya-dirty-file-row", { hasText: "committed.txt" }),
  ).toBeVisible();
  await expect(
    popover.locator(".aya-dirty-file-row", { hasText: "added.txt" }),
  ).toBeVisible();

  // Click the modified file -> diff viewer opens and shows the actual change.
  await popover.locator(".aya-dirty-file-row", { hasText: "committed.txt" }).click();
  const diff = popover.locator(".aya-diff-view");
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("twoX");

  // In-diff search reports a non-zero match count (not "0 matches").
  await popover.locator('input[placeholder="Search diff"]').fill("twoX");
  await expect(popover.locator(".aya-diff-search")).toContainText(/[1-9]\d* match/i);
});
