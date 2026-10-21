import { test, expect } from "./fixtures";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fireShortcut } from "./helpers/shortcut";

test.use({
  seedOptions: {
    gitRepo: true,
    split: false,
    singleTab: true,
    presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "cat" }],
  },
});

const SHOTS = "/tmp/aya-worktrees-ga-screens";
const paneBuffer = (window: import("@playwright/test").Page, id: string) => window.evaluate((paneId) => window.aya.ptyBuffer(paneId), id);

test("create worktrees from one prompt and offer safe branch deletion", async ({ window, seeded }) => {
  mkdirSync(SHOTS, { recursive: true });
  await expect(window.locator(".aya-worktree-add")).toBeVisible();
  await expect(window.locator(".aya-worktree-add")).toContainText("New worktrees");
  await window.locator(".aya-sidebar").screenshot({ path: join(SHOTS, "sidebar-after.png") });
  await window.getByRole("button", { name: "Settings" }).click();
  const settings = window.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings).not.toContainText("Enable worktrees support");
  await settings.getByText("Harness-aware search").scrollIntoViewIfNeeded();
  await settings.screenshot({ path: join(SHOTS, "settings-after.png") });
  await window.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  await window.locator(".aya-worktree-add").click();
  const dialog = window.getByRole("dialog", { name: "Start in worktrees" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Starting branch or ref")).toHaveValue("feature/foo");
  await dialog.screenshot({ path: join(SHOTS, "create-dialog-after.png") });
  await dialog.getByLabel("Starting branch or ref").fill("feature/foo");
  await dialog.getByLabel("Worktree name").fill("batch");
  await dialog.getByLabel("Number of worktrees").fill("2");
  await dialog.getByLabel("Prompt").fill("say hello from the shared task");
  await dialog.getByRole("button", { name: "Start worktrees" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(window.locator(".aya-worktree-header")).toHaveCount(3);
  await expect(window.locator(".aya-worktree-header")).toContainText(["project", "batch-1", "batch-2"]);
  const rows = window.locator(".aya-sidebar-row");
  await expect(rows).toHaveCount(3);
  const paneIds = await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-terminal-id")));
  for (const id of paneIds.slice(1)) {
    await expect.poll(() => paneBuffer(window, id!), { timeout: 15_000 }).toContain("say hello from the shared task");
  }
  await window.screenshot({ path: join(SHOTS, "two-panes-started-after.png") });

  const firstRemove = window.locator('.aya-worktree-header-remove[title="Remove worktree batch-1"]');
  await firstRemove.click();
  const safeDialog = window.getByRole("dialog", { name: "Remove worktree?" });
  const safeBranch = safeDialog.getByRole("checkbox", { name: /Also delete branch aya\/batch-1/ });
  await expect(safeBranch).toBeChecked();
  await safeDialog.screenshot({ path: join(SHOTS, "remove-safe-branch-after.png") });
  await safeDialog.getByRole("button", { name: "Remove worktree" }).click();
  await expect(safeDialog).toHaveCount(0);
  await expect(window.locator(".aya-worktree-header")).toHaveCount(2);

  const secondPath = join(seeded.projectDir + ".worktrees", "batch-2");
  execFileSync("git", ["-c", "user.email=e2e@example.test", "-c", "user.name=E2E", "commit", "--allow-empty", "-m", "unshared"], { cwd: secondPath });
  await window.locator('.aya-worktree-header-remove[title="Remove worktree batch-2"]').click();
  const unsafeDialog = window.getByRole("dialog", { name: "Remove worktree?" });
  const unsafeBranch = unsafeDialog.getByRole("checkbox", { name: /Also delete branch aya\/batch-2/ });
  await expect(unsafeBranch).not.toBeChecked();
  await expect(unsafeBranch).toBeDisabled();
  await expect(unsafeDialog).toContainText("1 commit that is not pushed or merged into feature/foo");
  await unsafeDialog.screenshot({ path: join(SHOTS, "remove-unshared-branch-after.png") });
  await unsafeDialog.getByRole("button", { name: "Remove worktree" }).click();
  await expect(unsafeDialog).toHaveCount(0);

  await window.locator(".aya-worktree-add").click();
  const lateDialog = window.getByRole("dialog", { name: "Start in worktrees" });
  await expect(lateDialog.getByLabel("Starting branch or ref")).toHaveValue("feature/foo");
  await lateDialog.getByLabel("Worktree name").fill("late-safe-check");
  await expect(lateDialog.getByLabel("Worktree name")).toHaveValue("late-safe-check");
  await lateDialog.getByLabel("Number of worktrees").fill("1");
  await lateDialog.getByRole("button", { name: "Start worktrees" }).click();
  const lateHeader = window.locator(".aya-worktree-header").filter({ hasText: /late-safe-check-1/ });
  await expect(lateHeader).toHaveCount(1);
  const latePath = (await lateHeader.getAttribute("title"))!.split("\n")[0].split(" · ")[0];
  const lateBranchName = (await lateHeader.locator(".aya-worktree-header-branch").textContent())!;
  await lateHeader.locator(".aya-worktree-header-remove").click();
  const changedDialog = window.getByRole("dialog", { name: "Remove worktree?" });
  const lateBranch = changedDialog.getByRole("checkbox", { name: `Also delete branch ${lateBranchName}`, exact: true });
  await expect(lateBranch).toBeChecked();
  execFileSync("git", ["-c", "user.email=e2e@example.test", "-c", "user.name=E2E", "commit", "--allow-empty", "-m", "arrived while remove dialog was open"], { cwd: latePath });
  const warning = window.waitForEvent("dialog").then(async (nativeDialog) => {
    expect(nativeDialog.message()).toBe("The worktree was removed, but Git kept the branch.");
    await nativeDialog.accept();
  });
  await changedDialog.getByRole("button", { name: "Remove worktree" }).click();
  await warning;
  assert.equal(execFileSync("git", ["branch", "--list", lateBranchName], { cwd: seeded.projectDir }).toString().trim(), lateBranchName);

  const existingRowsBeforeBlank = await window.locator(".aya-sidebar-row").count();
  await window.locator(".aya-worktree-add").click();
  const noPrompt = window.getByRole("dialog", { name: "Start in worktrees" });
  await noPrompt.getByLabel("Worktree name").fill("blank");
  await noPrompt.getByLabel("Number of worktrees").fill("1");
  await expect(noPrompt.getByRole("button", { name: "Start worktrees" })).toBeEnabled();
  await noPrompt.getByRole("button", { name: "Start worktrees" }).click();
  const rowsAfterBlank = window.locator(".aya-sidebar-row");
  await expect(rowsAfterBlank).toHaveCount(existingRowsBeforeBlank + 1);
  const blankPaneId = await rowsAfterBlank.last().getAttribute("data-terminal-id");
  await expect.poll(() => paneBuffer(window, blankPaneId!), { timeout: 5_000 }).toBe("");
});

test.describe("remote project", () => {
  test.use({ seedOptions: { remoteProject: true, split: false, singleTab: true } });
  test("worktree creation is disabled with a plain reason", async ({ window }) => {
    const action = window.locator(".aya-worktree-add");
    await expect(action).toBeDisabled();
    await expect(action).toContainText("available for local projects");
    await expect(action).toHaveAttribute("title", "Worktrees are available for local projects only");
  });
});

test.describe("project switching during worktree creation", () => {
  test.use({ seedOptions: { gitRepo: true, split: false, secondProject: true, singleTab: true } });

  test("closes the create dialog when its project changes before submit", async ({ app, window, seeded }) => {
    const worktreesBefore = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: seeded.projectDir,
    }).toString();

    await window.locator(".aya-worktree-add").click();
    const dialog = window.getByRole("dialog", { name: "Start in worktrees" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Worktree name").fill("must-not-start");

    await fireShortcut(app, "project-2");
    await expect(dialog).toHaveCount(0);
    await fireShortcut(app, "project-1");

    await expect(window.locator(".aya-worktree-header")).toHaveCount(1);
    assert.equal(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: seeded.projectDir }).toString(),
      worktreesBefore,
    );
  });

  test("starts new panes in the project where the worktree dialog was opened", async ({ app, window, seeded }) => {
    const hook = join(seeded.projectDir, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nsleep 2\n", { mode: 0o755 });
    await window.locator(".aya-worktree-add").click();
    const dialog = window.getByRole("dialog", { name: "Start in worktrees" });
    await expect(dialog.getByLabel("Starting branch or ref")).toHaveValue("feature/foo");
    await dialog.getByLabel("Worktree name").fill("switch-race");
    await expect(dialog.getByLabel("Worktree name")).toHaveValue("switch-race");
    await dialog.getByLabel("Number of worktrees").fill("1");
    await dialog.getByRole("button", { name: "Start worktrees" }).click();
    await fireShortcut(app, "project-2");
    await expect(window.locator(".aya-sidebar-row[data-terminal-name='shell 3']")).toBeVisible();
    await expect(dialog).toHaveCount(0);

    await fireShortcut(app, "project-1");
    await expect(window.locator(".aya-worktree-header").filter({ hasText: /switch-race-1/ })).toHaveCount(1);
    await expect(window.locator(".aya-sidebar-row")).toHaveCount(2);
    await fireShortcut(app, "project-2");
    await expect(window.locator(".aya-sidebar-row")).toHaveCount(1);
  });
});
