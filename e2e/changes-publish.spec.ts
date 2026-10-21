import { expect, test } from "./fixtures";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    if [ -f "$state/unauthenticated" ]; then echo 'You are not logged into any GitHub hosts. private account and token details' >&2; exit 1; fi
    exit 0 ;;
  "repo view") echo 'https://github.com/aya-e2e/project'; exit 0 ;;
  "pr view")
    if [ -f "$FAKE_GH_STATE/existing-pr" ]; then cat "$FAKE_GH_STATE/existing-pr"; exit 0; fi
    echo 'no pull requests found for branch' >&2; exit 1 ;;
  "pr create") echo 'https://github.com/aya-e2e/project/pull/42'; exit 0 ;;
esac
exit 2
`);
chmodSync(fakeGh, 0o755);
const fakeGit = join(fakeBin, "git");
const gitDelayEnabled = join(fakeState, "git-delay-enabled");
const gitDelayStarted = join(fakeState, "git-delay-started");
const gitDelayRelease = join(fakeState, "git-delay-release");
const gitDelayDone = join(fakeState, "git-delay-done");
const publishStatusHold = join(fakeState, "publish-status-hold");
const publishStatusStarted = join(fakeState, "publish-status-started");
const publishStatusPid = join(fakeState, "publish-status-pid");
writeFileSync(fakeGit, `#!/bin/sh
if [ -f "$FAKE_GIT_DELAY_ENABLED" ] && [ "$(pwd -P)" = "$FAKE_GIT_DELAY_DIR" ] && [ "$1" = "symbolic-ref" ] && [ "$4" = "HEAD" ]; then
  : > "$FAKE_GIT_DELAY_STARTED"
  while [ ! -f "$FAKE_GIT_DELAY_RELEASE" ]; do sleep 0.01; done
fi
if [ -f "$FAKE_GIT_PUBLISH_STATUS_HOLD" ] && [ "$1" = "symbolic-ref" ] && [ "$2" = "--quiet" ] && [ "$3" = "--short" ] && [ "$4" = "HEAD" ]; then
  : > "$FAKE_GIT_PUBLISH_STATUS_STARTED"
  exec node -e 'require("node:fs").writeFileSync(process.env.FAKE_GIT_PUBLISH_STATUS_PID, String(process.pid)); setInterval(() => {}, 1000);'
fi
/usr/bin/git "$@"
status=$?
if [ "$1" = "symbolic-ref" ] && [ "$4" = "HEAD" ] && [ -n "$FAKE_GIT_DELAY_DONE" ]; then : > "$FAKE_GIT_DELAY_DONE"; fi
exit "$status"
`);
chmodSync(fakeGit, 0o755);
const launchEnv = {
  PATH: `${fakeBin}:${process.env.PATH}`,
  FAKE_GH_STATE: fakeState,
  FAKE_GIT_PUBLISH_STATUS_HOLD: publishStatusHold,
  FAKE_GIT_PUBLISH_STATUS_STARTED: publishStatusStarted,
  FAKE_GIT_PUBLISH_STATUS_PID: publishStatusPid,
};
test.use({ seedOptions: { gitRepo: true, launchEnv } });
test.afterAll(() => rmSync(fakeRoot, { recursive: true, force: true }));

async function openChanges(window: import("@playwright/test").Page) {
  await window.locator(".aya-statusbar-button", { hasText: "dirty" }).click();
  const popover = window.getByRole("dialog", { name: "Changed files" });
  await expect(popover).toBeVisible();
  return popover;
}

async function installFakeGit(app: import("@playwright/test").ElectronApplication) {
  await app.evaluate((_api, bin) => { process.env.PATH = `${bin}:${process.env.PATH}`; }, fakeBin);
}

function addFakeRemote(repo: string) {
  execFileSync("git", ["remote", "add", "origin", "https://github.com/aya-e2e/project"], { cwd: repo });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: repo });
}

function statusCallsFor(directory: string, root: string): number {
  const log = join(root, "e2e-git-publish-status.log");
  if (!existsSync(log)) return 0;
  const wanted = realpathSync(directory);
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).filter((line) => line === wanted).length;
}

async function expectPidGone(pid: number) {
  await expect.poll(() => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  }, { timeout: 2_000 }).toBe(false);
}

test("changes panel commits, sets upstream, pushes and opens the pull request without creating it twice", async ({ window, app, seeded }) => {
  const externalOpenLog = join(seeded.root, "e2e-open-external.log");
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

  writeFileSync(externalOpenLog, "");
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
  expect(readFileSync(externalOpenLog, "utf8").trim().split("\n")).toEqual([
    "https://github.com/aya-e2e/project/pull/42",
    "https://github.com/aya-e2e/project/pull/42",
  ]);
});

test("publish status is queried once per Changes opening, never on mount or close", async ({ window, seeded }) => {
  const repo = realpathSync(seeded.projectDir);
  await expect.poll(() => statusCallsFor(repo, seeded.root)).toBe(0);
  const popover = await openChanges(window);
  await expect.poll(() => statusCallsFor(repo, seeded.root)).toBe(1);
  await window.locator(".aya-statusbar-button").filter({ hasText: "dirty" }).click();
  await expect(popover).toBeHidden();
  await window.waitForTimeout(100);
  expect(statusCallsFor(repo, seeded.root)).toBe(1);
  await openChanges(window);
  await expect.poll(() => statusCallsFor(repo, seeded.root)).toBe(2);
});

test("closing Changes aborts its pending Git status child", async ({ window, app }) => {
  await installFakeGit(app);
  rmSync(publishStatusStarted, { force: true });
  rmSync(publishStatusPid, { force: true });
  writeFileSync(publishStatusHold, "");
  try {
    const popover = await openChanges(window);
    await expect.poll(() => existsSync(publishStatusStarted)).toBe(true);
    await expect.poll(() => existsSync(publishStatusPid)).toBe(true);
    const pid = Number(readFileSync(publishStatusPid, "utf8"));
    await window.locator(".aya-statusbar-button").filter({ hasText: "dirty" }).click();
    await expect(popover).toBeHidden();
    await expectPidGone(pid);
  } finally {
    rmSync(publishStatusHold, { force: true });
    rmSync(publishStatusStarted, { force: true });
    rmSync(publishStatusPid, { force: true });
  }
});

test("quitting Aya while publish status is held aborts the Git child and exits", async ({ window, app }) => {
  await installFakeGit(app);
  rmSync(publishStatusStarted, { force: true });
  rmSync(publishStatusPid, { force: true });
  writeFileSync(publishStatusHold, "");
  try {
    await openChanges(window);
    await expect.poll(() => existsSync(publishStatusStarted)).toBe(true);
    await expect.poll(() => existsSync(publishStatusPid)).toBe(true);
    const pid = Number(readFileSync(publishStatusPid, "utf8"));
    const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Aya did not quit with a held publish-status query")), 5_000)),
    ]);
    await expectPidGone(pid);
  } finally {
    rmSync(publishStatusHold, { force: true });
    rmSync(publishStatusStarted, { force: true });
    rmSync(publishStatusPid, { force: true });
  }
});

test("first push from the Changes panel sets the upstream", async ({ window, seeded }) => {
  const repo = seeded.projectDir;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("config", "user.name", "Aya E2E");
  git("config", "user.email", "aya-e2e@example.test");
  const bare = join(seeded.root, "first-push-origin.git");
  mkdirSync(bare);
  execFileSync("git", ["init", "--bare", "-q", bare]);
  git("remote", "add", "origin", bare);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  git("remote", "set-head", "origin", "main");
  expect(() => execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: repo, stdio: "ignore" })).toThrow();

  const popover = await openChanges(window);
  await popover.getByRole("button", { name: "Push branch" }).click();
  await expect(popover.getByRole("status")).toHaveText("Pushed.");
  expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: repo, encoding: "utf8" }).trim()).toBe("origin/feature/foo");
});

test("an existing pull request opens without creating a duplicate", async ({ window, seeded }) => {
  const repo = seeded.projectDir;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  const bare = join(seeded.root, "existing-pr-origin.git");
  mkdirSync(bare);
  execFileSync("git", ["init", "--bare", "-q", bare]);
  git("remote", "add", "origin", bare);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  git("remote", "set-head", "origin", "main");
  git("push", "-q", "--set-upstream", "origin", "HEAD");
  const prUrl = "https://github.com/aya-e2e/project/pull/19";
  writeFileSync(join(fakeState, "existing-pr"), `${prUrl}\n`);
  rmSync(join(fakeState, "calls"), { force: true });
  try {
    const popover = await openChanges(window);
    await popover.getByRole("button", { name: "Create pull request" }).click();
    await expect(popover.getByRole("status")).toHaveText("Pull request opened.");
    await expect(popover.getByRole("button", { name: "Open pull request" })).toBeVisible();
    const calls = readFileSync(join(fakeState, "calls"), "utf8");
    expect(calls).toContain("pr view feature/foo");
    expect(calls).not.toContain("pr create");
  } finally { rmSync(join(fakeState, "existing-pr"), { force: true }); }
});

test("without a remote, changes panel disables publishing and shows one reason", async ({ window }) => {
  const popover = await openChanges(window);
  const push = popover.getByRole("button", { name: "Push branch" });
  const pullRequest = popover.getByRole("button", { name: "Create pull request" });
  await expect(push).toBeDisabled();
  await expect(pullRequest).toBeDisabled();
  expect(await push.evaluate((element) => getComputedStyle(element).opacity)).toBe("0.45");
  expect(await pullRequest.evaluate((element) => getComputedStyle(element).opacity)).toBe("0.45");
  await expect(popover.getByText("Add a Git remote before pushing or opening a pull request.")).toHaveCount(1);
  await popover.screenshot({ path: "/tmp/changes-publish-no-remote.png" });
});

test("changes panel explains when gh is missing", async ({ window, seeded }) => {
  addFakeRemote(seeded.projectDir);
  writeFileSync(join(fakeState, "missing"), "");
  try {
    let popover = await openChanges(window);
    const push = popover.getByRole("button", { name: "Push branch" });
    const pullRequest = popover.getByRole("button", { name: "Create pull request" });
    await expect(push).toBeEnabled();
    await expect(pullRequest).toBeEnabled();
    expect(await push.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
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

test.describe("publish status checkout races", () => {
  test.use({ seedOptions: { gitRepo: true, gitWorktree: true, launchEnv } });

  test("a delayed publish status from the old checkout cannot replace the selected checkout status", async ({ window, app, seeded }) => {
    const main = seeded.projectDir;
    execFileSync("git", ["remote", "add", "origin", "https://github.com/aya-e2e/project"], { cwd: main });
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: main });
    execFileSync("git", ["config", "branch.feature/foo.pushRemote", "missing-remote"], { cwd: main });
    execFileSync("git", ["config", "branch.wt/bar.pushRemote", "origin"], { cwd: main });
    await expect(window.locator('[data-testid="checkout-picker"]')).toContainText("feature/foo");

    await app.evaluate((_api, setup) => {
      process.env.PATH = `${setup.fakeBin}:${process.env.PATH}`;
      process.env.FAKE_GIT_DELAY_DIR = setup.main;
      process.env.FAKE_GIT_DELAY_ENABLED = setup.enabled;
      process.env.FAKE_GIT_DELAY_STARTED = setup.started;
      process.env.FAKE_GIT_DELAY_RELEASE = setup.release;
      process.env.FAKE_GIT_DELAY_DONE = setup.done;
    }, { fakeBin, main: realpathSync(main), enabled: gitDelayEnabled, started: gitDelayStarted, release: gitDelayRelease, done: gitDelayDone });
    writeFileSync(gitDelayEnabled, "");

    let popover = await openChanges(window);
    await expect.poll(() => existsSync(gitDelayStarted)).toBe(true);
    await window.locator('[data-testid="checkout-picker"]').click();
    await window.locator(".aya-checkout-row", { hasText: "wt-bar" }).click();
    await expect(window.locator('[data-testid="checkout-picker"]')).toContainText("wt/bar");
    popover = await openChanges(window);
    const push = popover.getByRole("button", { name: "Push branch" });
    await expect(push).toBeEnabled();

    writeFileSync(gitDelayRelease, "");
    await expect.poll(() => existsSync(gitDelayDone)).toBe(true);
    await window.waitForTimeout(100);
    await expect(push).toBeEnabled();
  });
});
