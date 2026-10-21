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
    if [ "$4" = "--json" ] && [ -f "$state/check-pr.json" ]; then cat "$state/check-pr.json"; exit 0; fi
    if [ -f "$FAKE_GH_STATE/existing-pr" ]; then cat "$FAKE_GH_STATE/existing-pr"; exit 0; fi
    echo 'no pull requests found for branch' >&2; exit 1 ;;
  "pr checks")
    if [ -f "$state/checks-unavailable" ]; then echo 'temporary network failure' >&2; exit 1; fi
    if [ -f "$state/checks-slow" ]; then
      : > "$state/checks-slow-started"
      while [ ! -f "$state/checks-slow-release" ]; do sleep 0.01; done
    fi
    [ -f "$state/checks.json" ] && { cat "$state/checks.json"; exit 0; }; echo '[]'; exit 0 ;;
  "run view")
    if [ "$3" = "11111" ]; then
      : > "$state/slow-a-started"
      while [ ! -f "$state/slow-a-release" ]; do sleep 0.01; done
      echo 'slow first check output'
      exit 0
    fi
    if [ "$3" = "22222" ]; then echo 'fast second check output'; exit 0; fi
    if [ "$3" = "33333" ] && [ -f "$state/send-slow" ]; then
      : > "$state/send-slow-started"
      while [ ! -f "$state/send-slow-release" ]; do sleep 0.01; done
    fi
    [ -f "$state/failed-log" ] && { cat "$state/failed-log"; exit 0; }; exit 0 ;;
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
  exec node -e 'require("node:fs").writeFileSync(process.env.FAKE_GIT_PUBLISH_STATUS_PID, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
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

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const recorderPreset = {
  id: "ci-review-target", name: "CI review target", icon: "R", color: "", agent: "claude",
  command: `${quote(process.execPath)} ${quote(join(__dirname, "helpers", "diff-review-pane.cjs"))} record "$AYA_HOME/ci-review-$AYA_TERMINAL_ID.log"`,
};

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

test.describe("failed pull request checks", () => {
  test.use({ seedOptions: { gitRepo: true, rightTab: { presetId: "ci-review-target", name: "CI review target" }, presetList: [recorderPreset], launchEnv } });

  test("previews the failed job tail and sends it to the selected pane", async ({ window, seeded }) => {
    addFakeRemote(seeded.projectDir);
    writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({
      url: "https://github.com/aya-e2e/project/pull/42", state: "OPEN", isDraft: false,
    }));
    writeFileSync(join(fakeState, "checks.json"), JSON.stringify([{
      name: "Linux tests", state: "failure", bucket: "fail",
      link: "https://github.com/aya-e2e/project/actions/runs/12345/job/67890",
    }]));
    writeFileSync(join(fakeState, "failed-log"), "AssertionError: expected result\nAWS_SECRET=never-send-this\n\u001b[31mfailed near test 42\u001b[0m\n");
    try {
    const log = join(seeded.ayaHome, `ci-review-${seeded.tabIds.right}.log`);
    await expect.poll(() => existsSync(`${log}.ready`)).toBe(true);

    const popover = await openChanges(window);
    const checks = window.getByRole("region", { name: "Pull request checks" });
    await expect(checks).toBeVisible();
    await expect(checks).toContainText("Linux tests");
    await expect(checks).toContainText("Failed");
    await checks.getByLabel("Send failed checks to").selectOption(seeded.tabIds.right);
    const pickerStyle = await checks.locator("#aya-ci-target").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius, font: style.fontFamily, size: style.fontSize };
    });
    const panelInputStyle = await popover.locator(".aya-dirty-commit > input").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius, font: style.fontFamily, size: style.fontSize };
    });
    expect(pickerStyle).toEqual(panelInputStyle);
    await checks.getByRole("button", { name: "Preview Linux tests failure details" }).click();
    const preview = checks.getByRole("textbox", { name: "Exact message to send" });
    const previewText = await preview.inputValue();
    expect(previewText).toContain("Tail of the failed job log (up to 8 KB");
    expect(previewText).toContain("AssertionError: expected result");
    expect(previewText).toContain("failed near test 42");
    expect(previewText).not.toContain("AWS_SECRET");
    expect(previewText).not.toContain("never-send-this");
    await expect(checks).toContainText("Will send to CI review target");
    await window.setViewportSize({ width: 1100, height: 720 });
    await expect(checks.locator("#aya-ci-target")).toBeInViewport();
    await expect(preview).toBeInViewport();
    await expect(checks.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await window.setViewportSize({ width: 1100, height: 600 });
    const compactScrollState = await popover.locator(".aya-statusbar-popover-content").evaluate((element) => ({ height: element.clientHeight, total: element.scrollHeight }));
    expect(compactScrollState.total).toBeGreaterThan(compactScrollState.height);
    await checks.locator("#aya-ci-target").scrollIntoViewIfNeeded();
    await expect(checks.locator("#aya-ci-target")).toBeInViewport();
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toBeInViewport();
    await checks.getByRole("button", { name: "Send", exact: true }).scrollIntoViewIfNeeded();
    await expect(checks.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await window.setViewportSize({ width: 1100, height: 1100 });
    await expect(preview).toBeInViewport();
    await expect(checks.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await expect(checks.locator("#aya-ci-target")).toBeInViewport();
    const panelBox = await popover.boundingBox();
    if (!panelBox) throw new Error("Changes panel is not visible for the preview screenshot");
    await window.screenshot({ path: "/tmp/changes-publish-checks-preview.png", clip: panelBox });
    const sendHold = `${log}.hold`;
    writeFileSync(sendHold, "");
    await checks.getByRole("button", { name: "Send", exact: true }).click();
    try {
      await expect(window.getByRole("status")).toHaveText("Sending...");
      await popover.screenshot({ path: "/tmp/changes-publish-checks-sending.png" });
    } finally {
      rmSync(sendHold, { force: true });
    }
    await expect(window.getByRole("status")).toHaveText("Sent to CI review target.");
    await expect.poll(() => existsSync(log) ? readFileSync(log, "utf8") : "").toContain("failed near test 42");
    const received = readFileSync(log, "utf8");
    expect(received.split("\x1b[200~")).toHaveLength(2);
    expect(received.split("\x1b[201~")).toHaveLength(2);
    expect(received.endsWith("\r")).toBe(true);
    expect(received).not.toContain("AWS_SECRET=never-send-this");
    await popover.screenshot({ path: "/tmp/changes-publish-checks-sent.png" });
    } finally {
      for (const name of ["check-pr.json", "checks.json", "failed-log"]) rmSync(join(fakeState, name), { force: true });
    }
  });

  test("a failed send clears its Sending status and asks for a fresh preview", async ({ window, seeded }) => {
    addFakeRemote(seeded.projectDir);
    execFileSync("git", ["config", "user.name", "Aya E2E"], { cwd: seeded.projectDir });
    execFileSync("git", ["config", "user.email", "aya-e2e@example.test"], { cwd: seeded.projectDir });
    writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({ url: "https://github.com/aya-e2e/project/pull/42", state: "OPEN", isDraft: false }));
    writeFileSync(join(fakeState, "checks.json"), JSON.stringify([{
      name: "Linux tests", state: "failure", bucket: "fail",
      link: "https://github.com/aya-e2e/project/actions/runs/12345/job/67890",
    }]));
    const log = join(seeded.ayaHome, `ci-review-${seeded.tabIds.right}.log`);
    writeFileSync(join(fakeState, "failed-log"), "initial log contents\n");
    try {
      await expect.poll(() => existsSync(`${log}.ready`)).toBe(true);
      const popover = await openChanges(window);
      await popover.getByRole("textbox", { name: "Commit message" }).fill("Commit before CI review");
      await popover.getByRole("button", { name: "Commit selected" }).click();
      await expect(popover.getByRole("status")).toContainText("Committed ");
      const checks = window.getByRole("region", { name: "Pull request checks" });
      await checks.getByLabel("Send failed checks to").selectOption(seeded.tabIds.right);
      await checks.getByRole("button", { name: "Preview Linux tests failure details" }).click();
      await expect(checks.getByRole("textbox", { name: "Exact message to send" })).toBeVisible();
      await expect(popover.locator(".aya-dirty-publish-notice")).toHaveCount(0);
      writeFileSync(join(fakeState, "failed-log"), "changed after preview\n");
      await checks.getByRole("button", { name: "Send", exact: true }).click();
      await expect(checks.getByRole("alert")).toHaveText("The failed job log changed. Review the updated preview before sending.");
      await expect(popover.locator(".aya-dirty-publish-notice")).toHaveCount(0);
      await expect(checks.getByRole("textbox", { name: "Exact message to send" })).toHaveCount(0);
      await expect(checks.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
      await expect(checks.getByRole("button", { name: "Retry" })).toHaveCount(0);
    } finally {
      for (const name of ["check-pr.json", "checks.json", "failed-log", "send-slow", "send-slow-release"]) rmSync(join(fakeState, name), { force: true });
    }
  });

  test("while sending one check, another target and preview cannot replace it", async ({ window, seeded }) => {
    addFakeRemote(seeded.projectDir);
    writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({ url: "https://github.com/aya-e2e/project/pull/42", state: "OPEN", isDraft: false }));
    writeFileSync(join(fakeState, "checks.json"), JSON.stringify([
      { name: "Linux tests", state: "failure", bucket: "fail", link: "https://github.com/aya-e2e/project/actions/runs/33333/job/67890" },
      { name: "macOS tests", state: "failure", bucket: "fail", link: "https://github.com/aya-e2e/project/actions/runs/22222/job/67890" },
    ]));
    writeFileSync(join(fakeState, "failed-log"), "same log contents\n");
    const log = join(seeded.ayaHome, `ci-review-${seeded.tabIds.right}.log`);
    try {
      await expect.poll(() => existsSync(`${log}.ready`)).toBe(true);
      const popover = await openChanges(window);
      const checks = window.getByRole("region", { name: "Pull request checks" });
      const targetPicker = checks.getByLabel("Send failed checks to");
      await targetPicker.selectOption(seeded.tabIds.right);
      await checks.getByRole("button", { name: "Preview Linux tests failure details" }).click();
      await expect(checks.getByRole("textbox", { name: "Exact message to send" })).toBeVisible();
      writeFileSync(join(fakeState, "send-slow"), "");
      await checks.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => existsSync(join(fakeState, "send-slow-started"))).toBe(true);
      await expect(popover.getByRole("status")).toHaveText("Sending...");
      await expect(targetPicker).toBeDisabled();
      await expect(checks.getByRole("button", { name: "Preview macOS tests failure details" })).toBeDisabled();
      writeFileSync(join(fakeState, "send-slow-release"), "");
      await expect(popover.getByRole("status")).toHaveText("Sent to CI review target.");
      await expect(checks.getByRole("textbox", { name: "Exact message to send" })).toHaveCount(0);
    } finally {
      writeFileSync(join(fakeState, "send-slow-release"), "");
      for (const name of ["check-pr.json", "checks.json", "failed-log", "send-slow", "send-slow-started", "send-slow-release"]) rmSync(join(fakeState, name), { force: true });
    }
  });
});

test.describe("PR3 screenshot states", () => {
  test("captures pending, passing, failing, unavailable, merged, and closed checks", async ({ window, seeded }) => {
    addFakeRemote(seeded.projectDir);
    const checkUrl = "https://github.com/aya-e2e/project/actions/runs/12345/job/67890";
    const row = (bucket: string, state: string) => [{ name: "Linux tests", state, bucket, link: checkUrl }];
    const setChecks = (bucket: string, state: string) => writeFileSync(join(fakeState, "checks.json"), JSON.stringify(row(bucket, state)));
    const closeAndReopen = async (popover: import("@playwright/test").Locator) => {
      const trigger = window.locator(".aya-statusbar-popover-host > button").filter({ hasText: "dirty" });
      await trigger.click();
      await expect(popover).toBeHidden();
      await trigger.click();
      await expect(popover).toBeVisible();
    };
    writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({ url: "https://github.com/aya-e2e/project/pull/42", state: "OPEN", isDraft: false }));
    setChecks("pending", "queued");
    try {
      let popover = await openChanges(window);
      let checks = window.getByRole("region", { name: "Pull request checks" });
      await expect(checks).toContainText("Queued");
      await popover.screenshot({ path: "/tmp/changes-publish-checks-pending.png" });

      setChecks("pending", "in_progress");
      await closeAndReopen(popover);
      checks = window.getByRole("region", { name: "Pull request checks" });
      await expect(checks).toContainText("Running");

      setChecks("pass", "success");
      await closeAndReopen(popover);
      checks = window.getByRole("region", { name: "Pull request checks" });
      await expect(checks).toContainText("Passed");
      await popover.screenshot({ path: "/tmp/changes-publish-checks-passing.png" });

      setChecks("fail", "failure");
      await closeAndReopen(popover);
      checks = window.getByRole("region", { name: "Pull request checks" });
      await expect(checks).toContainText("Linux tests");
      await expect(checks).toContainText("Failed");
      await expect(checks).toContainText("Open log");
      await expect(checks.getByRole("button", { name: "Open Linux tests log" })).toBeVisible();
      await popover.screenshot({ path: "/tmp/changes-publish-checks-failing.png" });

      writeFileSync(join(fakeState, "checks-unavailable"), "");
      await expect(popover.getByText("Aya could not load pull request checks.", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(popover.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(popover.getByRole("button", { name: "Open pull request" })).toBeVisible();
      await checks.getByText("Aya could not load pull request checks.", { exact: true }).scrollIntoViewIfNeeded();
      await popover.screenshot({ path: "/tmp/changes-publish-checks-unavailable.png" });
      rmSync(join(fakeState, "checks-unavailable"), { force: true });
      await popover.getByRole("button", { name: "Retry" }).click();
      await expect(popover.getByRole("alert")).toHaveCount(0);

      for (const state of ["MERGED", "CLOSED"]) {
        writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({ url: "https://github.com/aya-e2e/project/pull/42", state, isDraft: false }));
        await closeAndReopen(popover);
        checks = window.getByRole("region", { name: "Pull request checks" });
        await expect(checks).toContainText(`This pull request is ${state.toLowerCase()}`);
        await popover.screenshot({ path: `/tmp/changes-publish-checks-${state.toLowerCase()}.png` });
      }
    } finally {
      for (const name of ["check-pr.json", "checks.json", "checks-unavailable"]) rmSync(join(fakeState, name), { force: true });
    }
  });
});

test("visibility changes do not overlap a pending checks refresh", async ({ window, seeded }) => {
  addFakeRemote(seeded.projectDir);
  writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({ url: "https://github.com/aya-e2e/project/pull/42", state: "OPEN", isDraft: false }));
  writeFileSync(join(fakeState, "checks.json"), JSON.stringify([{ name: "Linux tests", state: "queued", bucket: "pending" }]));
  writeFileSync(join(fakeState, "checks-slow"), "");
  rmSync(join(fakeState, "calls"), { force: true });
  const checksCalls = () => existsSync(join(fakeState, "calls"))
    ? readFileSync(join(fakeState, "calls"), "utf8").split("\n").filter((line) => line.startsWith("pr checks ")).length
    : 0;
  try {
    const popover = await openChanges(window);
    await expect.poll(() => existsSync(join(fakeState, "checks-slow-started"))).toBe(true);
    expect(checksCalls()).toBe(1);
    await window.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(checksCalls).toBe(1);
    writeFileSync(join(fakeState, "checks-slow-release"), "");
    await expect(popover.getByText("Queued")).toBeVisible();
    expect(checksCalls()).toBe(1);
  } finally {
    for (const name of ["check-pr.json", "checks.json", "checks-slow", "checks-slow-started", "checks-slow-release"]) {
      rmSync(join(fakeState, name), { force: true });
    }
  }
});

test.describe("failed checks with no open pane", () => {
  test.use({ seedOptions: {
    gitRepo: true,
    singleTab: { presetId: "ended", name: "Ended pane" },
    presetList: [{ id: "ended", name: "Ended pane", icon: "$", color: "", command: "exit 0" }],
    launchEnv,
  } });

  test("explains why a failed check cannot be sent without an open pane", async ({ window, seeded }) => {
    addFakeRemote(seeded.projectDir);
    writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({ url: "https://github.com/aya-e2e/project/pull/42", state: "OPEN", isDraft: false }));
    writeFileSync(join(fakeState, "checks.json"), JSON.stringify([{
      name: "Linux tests", state: "failure", bucket: "fail",
      link: "https://github.com/aya-e2e/project/actions/runs/12345/job/67890",
    }]));
    try {
      const popover = await openChanges(window);
      await expect.poll(() => window.getByRole("region", { name: "Pull request checks" }).textContent()).toContain("Failed");
      const checks = window.getByRole("region", { name: "Pull request checks" });
      await expect(checks).toContainText("Open an agent pane in this project before sending check details.");
      await expect(checks.getByRole("button", { name: "Preview Linux tests failure details" })).toBeDisabled();
    } finally {
      for (const name of ["check-pr.json", "checks.json"]) rmSync(join(fakeState, name), { force: true });
    }
  });
});

test.describe("overlapping failed-check previews", () => {
  test.use({ seedOptions: { gitRepo: true, rightTab: { presetId: "ci-review-target", name: "CI review target" }, presetList: [recorderPreset], launchEnv } });

  test("a late first preview cannot replace the selected second check", async ({ window, seeded }) => {
    addFakeRemote(seeded.projectDir);
    writeFileSync(join(fakeState, "check-pr.json"), JSON.stringify({ url: "https://github.com/aya-e2e/project/pull/42", state: "OPEN", isDraft: false }));
    writeFileSync(join(fakeState, "checks.json"), JSON.stringify([
      { name: "Linux tests", state: "failure", bucket: "fail", link: "https://github.com/aya-e2e/project/actions/runs/11111/job/1" },
      { name: "macOS tests", state: "failure", bucket: "fail", link: "https://github.com/aya-e2e/project/actions/runs/22222/job/2" },
    ]));
    try {
      const popover = await openChanges(window);
      const checks = window.getByRole("region", { name: "Pull request checks" });
      await expect(checks.getByText("Linux tests")).toBeVisible();
      await checks.getByRole("button", { name: "Preview Linux tests failure details" }).click();
      await expect.poll(() => existsSync(join(fakeState, "slow-a-started"))).toBe(true);
      await checks.getByRole("button", { name: "Preview macOS tests failure details" }).click();
      const preview = checks.getByRole("textbox", { name: "Exact message to send" });
      await expect(preview).toContainText("CI check failed: macOS tests");
      writeFileSync(join(fakeState, "slow-a-release"), "");
      await window.waitForTimeout(100);
      expect(await preview.inputValue()).toContain("CI check failed: macOS tests");
      expect(await preview.inputValue()).not.toContain("CI check failed: Linux tests");
    } finally {
      writeFileSync(join(fakeState, "slow-a-release"), "");
      for (const name of ["check-pr.json", "checks.json", "slow-a-started", "slow-a-release"]) rmSync(join(fakeState, name), { force: true });
    }
  });
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
