import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// The status bar's git surface describes the ACTIVE TERMINAL's checkout. With a
// tab bound to a git worktree, the project directory's branch and diff are the
// wrong answer - before this, selecting that tab still showed the main
// checkout, so the diff for the work happening in the worktree was invisible.

test.use({ seedOptions: { gitRepo: true, gitWorktree: true, split: false } });

function sidebarRow(window: Page, name: string) {
  return window.locator(".aya-sidebar-row", {
    has: window.locator(".aya-sidebar-name", { hasText: new RegExp(`^${name}$`) }),
  });
}

test("status bar git follows the active terminal's worktree", async ({ window }) => {
  const statusbar = window.locator(".aya-statusbar");
  const dirtyBtn = window.locator(".aya-statusbar-button", { hasText: "dirty" });

  // shell 1 runs in the project directory: its branch, its 2 dirty files.
  await expect(statusbar.locator(".aya-statusbar-item", { hasText: "feature/foo" })).toBeVisible({
    timeout: 10000,
  });
  await expect(dirtyBtn).toContainText("2 dirty", { timeout: 10000 });
  await expect(statusbar.locator(".aya-statusbar-worktree")).toHaveCount(0);

  // shell 2 is bound to the worktree -> branch, dirty count and the worktree
  // chip all switch over.
  await sidebarRow(window, "shell 2").click();
  await expect(statusbar.locator(".aya-statusbar-item", { hasText: "wt/bar" })).toBeVisible({
    timeout: 10000,
  });
  await expect(dirtyBtn).toContainText("1 dirty", { timeout: 10000 });
  await expect(statusbar.locator(".aya-statusbar-worktree")).toContainText("wt-bar");

  // The diff is the worktree's ("twoWT"), not the project directory's ("twoX").
  await dirtyBtn.click();
  const popover = window.locator(".aya-statusbar-popover");
  await expect(popover.locator(".aya-dirty-file-row")).toHaveCount(1);
  await popover.locator(".aya-dirty-file-row", { hasText: "committed.txt" }).click();
  const diff = popover.locator(".aya-diff-view");
  await expect(diff).toContainText("twoWT");
  await expect(diff).not.toContainText("twoX");

  // Back to shell 1: the project directory's state comes back, no stale
  // worktree file list left over in the popover.
  await sidebarRow(window, "shell 1").click();
  await expect(statusbar.locator(".aya-statusbar-item", { hasText: "feature/foo" })).toBeVisible({
    timeout: 10000,
  });
  await expect(popover).toHaveCount(0);
  await expect(dirtyBtn).toContainText("2 dirty", { timeout: 10000 });
});

// The case this was actually built for: nobody bound a tab to anything. You run
// an agent (or yourself) in the project directory, a worktree gets created, and
// the console moves into it. The status bar has to follow the console, because
// the cwd Aya spawned the terminal with says nothing about where it is now.
test("status bar follows a `cd` into a worktree", async ({ window, seeded }) => {
  const statusbar = window.locator(".aya-statusbar");
  await expect(statusbar.locator(".aya-statusbar-item", { hasText: "feature/foo" })).toBeVisible({
    timeout: 10000,
  });

  // shell 1 was spawned in the project directory; move it into the worktree.
  const pane = window.locator(".aya-pane").first();
  await pane.locator(".xterm-screen").click();
  await window.keyboard.insertText(`cd ${seeded.worktreeDir}`);
  await window.keyboard.press("Enter");

  // The cwd poll runs on the git cadence, so allow a couple of ticks.
  await expect(statusbar.locator(".aya-statusbar-item", { hasText: "wt/bar" })).toBeVisible({
    timeout: 15000,
  });
  await expect(statusbar.locator(".aya-statusbar-worktree")).toContainText("wt-bar");
  await expect(
    window.locator(".aya-statusbar-button", { hasText: "dirty" }),
  ).toContainText("1 dirty", { timeout: 10000 });

  // And back: the console leaves, the status bar leaves with it.
  await window.keyboard.insertText(`cd ${seeded.projectDir}`);
  await window.keyboard.press("Enter");
  await expect(statusbar.locator(".aya-statusbar-item", { hasText: "feature/foo" })).toBeVisible({
    timeout: 15000,
  });
});

test("the checkout picker pins a worktree until you follow the terminal again", async ({
  window,
}) => {
  const statusbar = window.locator(".aya-statusbar");
  const picker = window.locator('[data-testid="checkout-picker"]');
  // Two worktrees exist, so the branch chip is a picker.
  await expect(picker).toBeVisible({ timeout: 10000 });
  await expect(picker).toContainText("feature/foo");

  await picker.click();
  const rows = window.locator(".aya-checkout-row");
  await expect(rows).toHaveCount(2);
  // Each row carries that checkout's own branch and dirty count.
  await expect(rows.filter({ hasText: "wt-bar" })).toContainText("wt/bar");
  await expect(rows.filter({ hasText: "wt-bar" })).toContainText("1 dirty");
  await expect(rows.filter({ hasText: "feature/foo" })).toContainText("2 dirty");

  // Pin the worktree while the console stays in the project directory.
  await rows.filter({ hasText: "wt-bar" }).click();
  await expect(picker).toContainText("wt/bar");
  await expect(statusbar.locator(".aya-statusbar-worktree")).toContainText("wt-bar");
  await expect(
    window.locator(".aya-statusbar-button", { hasText: "dirty" }),
  ).toContainText("1 dirty", { timeout: 10000 });

  // Un-pin: back to what the terminal is in.
  await picker.click();
  await window.locator(".aya-statusbar-popover-action", { hasText: "Follow terminal" }).click();
  await expect(picker).toContainText("feature/foo", { timeout: 10000 });
});
