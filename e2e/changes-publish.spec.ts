import { expect, test } from "./fixtures";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const fakeBin = mkdtempSync(join(tmpdir(), "aya-gh-publish-"));
const fakeGh = join(fakeBin, "gh");
writeFileSync(fakeGh, `#!/bin/sh
case "$1 $2" in
  "--version ") echo 'gh version test'; exit 0 ;;
  "auth status") exit 0 ;;
  "repo view") echo 'https://github.com/aya-e2e/project'; exit 0 ;;
  "pr view") exit 1 ;;
  "pr create") echo 'https://github.com/aya-e2e/project/pull/42'; exit 0 ;;
esac
exit 2
`);
chmodSync(fakeGh, 0o755);
test.use({ seedOptions: { gitRepo: true, launchEnv: { PATH: `${fakeBin}:${process.env.PATH}` } } });
test.afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));

test("changes panel commits, pushes to a local bare remote and opens the gh pull request link", async ({ window, app, seeded }) => {
  const repo = seeded.projectDir;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("config", "user.name", "Aya E2E");
  git("config", "user.email", "aya-e2e@example.test");
  const bare = join(seeded.root, "origin.git");
  mkdirSync(bare);
  execFileSync("git", ["init", "--bare", "-q", bare]);
  git("remote", "add", "origin", bare);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  git("remote", "set-head", "origin", "main");
  git("push", "-q", "--set-upstream", "origin", "HEAD");

  await app.evaluate(({ shell }) => {
    (globalThis as any).__openedUrls = [];
    shell.openExternal = async (url: string) => { (globalThis as any).__openedUrls.push(url); };
  });
  const dirty = window.locator(".aya-statusbar-button", { hasText: "dirty" });
  await dirty.click();
  const popover = window.getByRole("dialog", { name: "Changed files" });
  await expect(popover.locator(".aya-dirty-file-row")).toHaveCount(2);
  await window.screenshot({ path: "/tmp/changes-publish-before.png" });
  await popover.getByRole("textbox", { name: "Commit message" }).fill("Publish selected work");
  await popover.getByRole("button", { name: "Commit selected" }).click();
  await expect(popover.getByRole("status")).toContainText("Committed ");
  expect(await popover.getByRole("status").textContent()).toBe(`Committed ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()}.`);
  await expect(popover.getByText("No changed files.")).toBeVisible();
  await popover.getByRole("button", { name: "Push branch" }).click();
  await expect(popover.getByRole("status")).toHaveText("Branch pushed.");
  expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: repo, encoding: "utf8" }).trim()).toBe("origin/feature/foo");
  const changesButton = window.locator(".aya-statusbar-popover-host > button").filter({ hasText: "clean" });
  await changesButton.click();
  await expect(popover).toBeHidden();
  await changesButton.click();
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: "Create pull request" }).click();
  await expect(popover.getByRole("status")).toHaveText("Pull request opened.");
  expect(await app.evaluate(() => (globalThis as any).__openedUrls)).toEqual([
    "https://github.com/aya-e2e/project/pull/42",
  ]);
  await window.screenshot({ path: "/tmp/changes-publish-after.png" });
});
