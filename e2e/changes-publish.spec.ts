import { expect, test } from "./fixtures";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const fakeRoot = mkdtempSync(join(tmpdir(), "aya-gh-publish-"));
const fakeBin = join(fakeRoot, "bin");
const fakeState = join(fakeRoot, "state");
mkdirSync(fakeBin);
mkdirSync(fakeState);
const fakeGh = join(fakeBin, "gh");
writeFileSync(fakeGh, `#!/bin/sh
state="$FAKE_GH_STATE"
printf '%s\\n' "$*" >> "$state/calls"
if [ -f "$state/missing" ]; then echo 'gh: command not found' >&2; exit 127; fi
case "$1 $2" in
  "--version ") echo 'gh version test'; exit 0 ;;
  "auth status")
    if [ -f "$state/unauthenticated" ]; then echo 'private account and token details' >&2; exit 1; fi
    exit 0 ;;
  "repo view") echo 'https://github.com/aya-e2e/project'; exit 0 ;;
  "pr view") exit 1 ;;
  "pr create") echo 'https://github.com/aya-e2e/project/pull/42'; exit 0 ;;
esac
exit 2
`);
chmodSync(fakeGh, 0o755);
test.use({ seedOptions: { gitRepo: true, launchEnv: { PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GH_STATE: fakeState } } });
test.afterAll(() => rmSync(fakeRoot, { recursive: true, force: true }));

async function openChanges(window: import("@playwright/test").Page) {
  await window.locator(".aya-statusbar-button", { hasText: "dirty" }).click();
  const popover = window.getByRole("dialog", { name: "Changed files" });
  await expect(popover).toBeVisible();
  return popover;
}

function addFakeRemote(repo: string) {
  execFileSync("git", ["remote", "add", "origin", "https://github.com/aya-e2e/project"], { cwd: repo });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: repo });
}

test("changes panel commits, sets upstream, pushes and opens the pull request without creating it twice", async ({ window, app, seeded }) => {
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
  const popover = await openChanges(window);
  await expect(popover.locator(".aya-dirty-file-row")).toHaveCount(2);
  await popover.screenshot({ path: "/tmp/changes-publish-before.png" });
  await popover.getByRole("textbox", { name: "Commit message" }).fill("Publish selected work");
  await popover.getByRole("button", { name: "Commit selected" }).click();
  await expect(popover.getByRole("status")).toContainText("Committed ");
  expect(await popover.getByRole("status").textContent()).toBe(`Committed ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()}.`);
  await expect(popover.getByText("No changed files.")).toBeVisible();
  await popover.screenshot({ path: "/tmp/changes-publish-committed.png" });

  await popover.getByRole("button", { name: "Push branch" }).click();
  await expect(popover.getByRole("status")).toHaveText("Pushed.");
  expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: repo, encoding: "utf8" }).trim()).toBe("origin/feature/foo");
  await popover.screenshot({ path: "/tmp/changes-publish-pushed.png" });

  const changesButton = window.locator(".aya-statusbar-popover-host > button").filter({ hasText: "clean" });
  await changesButton.click();
  await expect(popover).toBeHidden();
  await changesButton.click();
  await expect(popover).toBeVisible();
  const createButton = popover.getByRole("button", { name: "Create pull request" });
  await createButton.click();
  await expect(popover.getByRole("status")).toHaveText("Pull request opened.");
  const openButton = popover.getByRole("button", { name: "Open pull request" });
  await expect(openButton).toBeVisible();
  await popover.screenshot({ path: "/tmp/changes-publish-open-pr.png" });
  const callsBeforeReopen = readFileSync(join(fakeState, "calls"), "utf8");
  expect(callsBeforeReopen.split("\n").filter((line) => line.startsWith("pr create "))).toHaveLength(1);
  await openButton.click();
  await expect(popover.getByRole("status")).toHaveText("Pull request opened.");
  const callsAfterReopen = readFileSync(join(fakeState, "calls"), "utf8");
  expect(callsAfterReopen.split("\n").filter((line) => line.startsWith("pr create "))).toHaveLength(1);
  expect(await app.evaluate(() => (globalThis as any).__openedUrls)).toEqual([
    "https://github.com/aya-e2e/project/pull/42",
    "https://github.com/aya-e2e/project/pull/42",
  ]);
});

test("without a remote, changes panel disables publishing and shows one reason", async ({ window }) => {
  const popover = await openChanges(window);
  await expect(popover.getByRole("button", { name: "Push branch" })).toBeDisabled();
  await expect(popover.getByRole("button", { name: "Create pull request" })).toBeDisabled();
  await expect(popover.getByText("Add a Git remote before pushing or opening a pull request.")).toHaveCount(1);
  await popover.screenshot({ path: "/tmp/changes-publish-no-remote.png" });
});

test("changes panel explains when gh is missing", async ({ window, seeded }) => {
  addFakeRemote(seeded.projectDir);
  writeFileSync(join(fakeState, "missing"), "");
  try {
    const popover = await openChanges(window);
    await expect(popover.getByRole("button", { name: "Push branch" })).toBeEnabled();
    await expect(popover.getByRole("button", { name: "Create pull request" })).toBeEnabled();
    await popover.getByRole("button", { name: "Create pull request" }).click();
    await expect(popover.getByRole("alert")).toHaveText("GitHub CLI is not installed. Install gh, then try again.");
    await popover.screenshot({ path: "/tmp/changes-publish-gh-missing.png" });
  } finally { rmSync(join(fakeState, "missing"), { force: true }); }
});

test("changes panel gives safe sign-in guidance without showing gh output", async ({ window, seeded }) => {
  addFakeRemote(seeded.projectDir);
  writeFileSync(join(fakeState, "unauthenticated"), "");
  try {
    const popover = await openChanges(window);
    await expect(popover.getByRole("button", { name: "Push branch" })).toBeEnabled();
    await expect(popover.getByRole("button", { name: "Create pull request" })).toBeEnabled();
    await popover.getByRole("button", { name: "Create pull request" }).click();
    await expect(popover.getByRole("alert")).toHaveText("GitHub CLI is not signed in. Run gh auth login, then try again.");
    await expect(popover.getByText("private account and token details")).toHaveCount(0);
    await popover.screenshot({ path: "/tmp/changes-publish-gh-unauthenticated.png" });
  } finally { rmSync(join(fakeState, "unauthenticated"), { force: true }); }
});
