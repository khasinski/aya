import { expect, test, closeAndWait, launchApp } from "./fixtures";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { envWithoutAya } from "./helpers/env";
import { AGENT_START_TIMEOUT_MS, AGENT_TEST_TIMEOUT_MS } from "./timeouts";

const NODE = process.execPath;
const PANE = join(__dirname, "helpers", "diff-review-pane.cjs");
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const recorderPreset = {
  id: "review-target", name: "Review target", icon: "R", color: "", agent: "claude",
  command: `${quote(NODE)} ${quote(PANE)} record "$AYA_HOME/diff-review-$AYA_TERMINAL_ID.log"`,
};
const holdPreset = {
  ...recorderPreset,
  command: `${quote(NODE)} ${quote(PANE)} hold "$AYA_HOME/diff-review-$AYA_TERMINAL_ID.log"`,
};
const shellPreset = { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" };

test.describe.configure({ timeout: AGENT_TEST_TIMEOUT_MS });

async function openDiff(window: import("@playwright/test").Page, expectedRow = "twoX") {
  const dirty = window.locator(".aya-statusbar-button", { hasText: "2 dirty" });
  await expect(dirty).toBeVisible({ timeout: AGENT_START_TIMEOUT_MS });
  const popover = window.locator(".aya-statusbar-popover");
  if (!(await popover.isVisible())) await dirty.click();
  const diff = window.locator(".aya-diff-view");
  if (!(await diff.isVisible())) await popover.getByRole("button", { name: "Show diff" }).click();
  await expect(diff).toBeVisible();
  await expect(diff).toContainText(expectedRow);
  return diff;
}

async function addComment(window: import("@playwright/test").Page, note: string) {
  const line = window.locator(".aya-diff-view-line--add", { hasText: "twoX" });
  await line.hover();
  await line.getByRole("button", { name: /comment on .* line/i }).click();
  const editor = window.getByRole("textbox", { name: "Comment on this diff line" });
  await editor.fill(note);
  await editor.press("Enter");
  await expect(window.locator(".aya-diff-comment").filter({ hasText: note })).toBeVisible();
}

function readBytes(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

test.describe("saved comments on the working diff", () => {
  test.use({ seedOptions: { gitRepo: true, rightTab: { presetId: "review-target", name: "Review target" }, presetList: [shellPreset, recorderPreset] } });

  test("survives popover close, reload, and app restart; prompt reaches the selected pane", async ({ seeded }) => {
    const log = join(seeded.ayaHome, `diff-review-${seeded.tabIds.right}.log`);
    let app = await launchApp(seeded);
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await expect.poll(() => existsSync(`${log}.ready`), { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
      await openDiff(window);
      await window.screenshot({ path: "/tmp/diff-comments-after-empty.png" });
      await addComment(window, "Please rename this value");
      await window.screenshot({ path: "/tmp/diff-comments-after-note.png" });

      await window.locator(".aya-statusbar-button", { hasText: "2 dirty" }).click();
      await expect(window.locator(".aya-statusbar-popover")).toHaveCount(0);
      await openDiff(window);
      await expect(window.locator(".aya-diff-comment")).toContainText("Please rename this value");

      await window.reload();
      await window.waitForLoadState("domcontentloaded");
      await openDiff(window);
      await expect(window.locator(".aya-diff-comment")).toContainText("Please rename this value");

      await closeAndWait(app);
      app = await launchApp(seeded);
      const afterRestart = await app.firstWindow();
      await afterRestart.waitForLoadState("domcontentloaded");
      await openDiff(afterRestart);
      await expect(afterRestart.locator(".aya-diff-comment")).toContainText("Please rename this value");
      await afterRestart.locator(".aya-diff-review-target select").selectOption(seeded.tabIds.right);
      await afterRestart.getByTestId("diff-review-send").click();
      await expect.poll(() => readBytes(log), { timeout: AGENT_START_TIMEOUT_MS }).toContain("Please rename this value");
      const received = readBytes(log);
      expect(received).toContain("Review comments on the current working diff");
      expect(received).toContain("committed.txt");
      expect(received).toContain("> +twoX");
      expect(received).toContain("\x1b[200~");
      await expect(afterRestart.locator(".aya-diff-comment").filter({ hasText: "Please rename this value" })).toContainText("Sent to Review target");
    } finally {
      await closeAndWait(app);
    }
  });

  test("keeps the quoted line visibly outdated when its checkout row disappears", async ({ window, seeded }) => {
    await openDiff(window);
    await addComment(window, "Keep this quote for review");
    writeFileSync(join(seeded.projectDir, "committed.txt"), "one\ntwoY\n");
    await window.locator(".aya-statusbar-popover-back").click();
    await window.locator(".aya-statusbar-button", { hasText: "2 dirty" }).click();
    await window.locator(".aya-statusbar-button", { hasText: "2 dirty" }).click();
    await window.locator(".aya-statusbar-popover").getByRole("button", { name: "Show diff" }).click();
    await expect(window.locator(".aya-diff-view")).toContainText("twoY");
    const outdated = window.getByTestId("diff-outdated-comments");
    await expect(outdated).toContainText("+twoX");
    await expect(outdated).toContainText("Keep this quote for review");
    await window.screenshot({ path: "/tmp/diff-comments-outdated.png" });
  });
});

test.describe("held-pane refusal", () => {
  test.use({ seedOptions: { gitRepo: true, rightTab: { presetId: "review-target", name: "Review target" }, presetList: [shellPreset, holdPreset] } });

  test("does not send review comments into an account setting prompt", async ({ window, seeded }) => {
    const log = join(seeded.ayaHome, `diff-review-${seeded.tabIds.right}.log`);
    await expect.poll(() => existsSync(`${log}.ready`), { timeout: AGENT_START_TIMEOUT_MS }).toBe(true);
    const cli = join(__dirname, "..", "bin", "aya");
    const state = () => execFileSync(cli, ["pane", "state", "Review target"], { env: { ...envWithoutAya(), AYA_HOME: seeded.ayaHome }, encoding: "utf8", timeout: 10_000 });
    await expect.poll(() => state(), { timeout: AGENT_START_TIMEOUT_MS }).toContain('"Review target": waiting');
    await openDiff(window);
    await addComment(window, "Do not choose this setting");
    await window.locator(".aya-diff-review-target select").selectOption(seeded.tabIds.right);
    await window.getByTestId("diff-review-send").click();
    await expect(window.getByRole("alert")).toContainText("Only the user answers it");
    expect(readBytes(log)).toBe("");
    await expect(window.locator(".aya-diff-comment").filter({ hasText: "Do not choose this setting" })).toBeVisible();
    await window.screenshot({ path: "/tmp/diff-comments-held-refusal.png" });
  });
});
