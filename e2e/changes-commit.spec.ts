import { expect, test } from "./fixtures";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test.use({ seedOptions: { gitRepo: true } });

test("changes panel commits only selected files and keeps state when Git refuses", async ({ window, seeded }) => {
  const repo = seeded.projectDir;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("config", "user.name", "Aya E2E");
  git("config", "user.email", "aya-e2e@example.test");

  writeFileSync(join(repo, "removed.txt"), "remove me\n");
  writeFileSync(join(repo, "keep-staged.txt"), "before\n");
  git("add", "--", "removed.txt", "keep-staged.txt");
  git("commit", "-qm", "add e2e fixtures");
  unlinkSync(join(repo, "removed.txt"));
  writeFileSync(join(repo, "keep-staged.txt"), "staged but not selected\n");
  git("add", "--", "keep-staged.txt");
  writeFileSync(join(repo, "committed.txt"), "selected tracked change\n");
  writeFileSync(join(repo, "added.txt"), "selected untracked file\n");

  const dirty = window.locator(".aya-statusbar-button", { hasText: "dirty" });
  await expect(dirty).toContainText("4 dirty");
  await dirty.click();
  const popover = window.getByRole("dialog", { name: "Changed files" });
  await expect(popover.locator(".aya-dirty-file-row")).toHaveCount(4);
  await window.screenshot({ path: "/tmp/changes-commit-after.png" });

  const commit = popover.getByRole("button", { name: "Commit selected" });
  await expect(commit).toBeDisabled();
  await popover.getByRole("checkbox", { name: "Select all changed files" }).uncheck();
  const message = popover.getByRole("textbox", { name: "Commit message" });
  await message.fill("Selected paths only");
  await expect(commit).toBeDisabled();
  await popover.getByRole("checkbox", { name: "Select committed.txt" }).check();
  await popover.getByRole("checkbox", { name: "Select added.txt" }).check();
  await popover.getByRole("checkbox", { name: "Select removed.txt" }).check();
  await expect(commit).toBeEnabled();

  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'test hook refused this commit' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  await commit.click();
  await expect(popover.getByRole("alert")).toContainText("test hook refused this commit");
  await expect(message).toHaveValue("Selected paths only");
  await expect(popover.getByRole("checkbox", { name: "Select committed.txt" })).toBeChecked();
  unlinkSync(hook);

  await commit.click();
  await expect(dirty).toContainText("1 dirty");
  await expect(popover.locator(".aya-dirty-file-row")).toHaveCount(1);
  expect(execFileSync("git", ["show", "--pretty=", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().split("\n").sort())
    .toEqual(["added.txt", "committed.txt", "removed.txt"]);
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toMatch(/^M  keep-staged\.txt$/m);
  await expect(popover.getByRole("textbox", { name: "Commit message" })).toHaveValue("");
  await window.screenshot({ path: "/tmp/changes-commit-after-success.png" });
});
