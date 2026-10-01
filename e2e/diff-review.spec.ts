import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// A comment left on a line of the status-bar diff reaches the agent pane as
// one prompt: the file and line, the quoted diff line, the note, then Enter.
// Both tabs are "agent" presets whose command just records what is typed.

// autoResume off: a restored agent tab would otherwise get `--continue`, which cat refuses.
const RECEIVER = `cat >> "$AYA_PROJECT_DIR/received-$AYA_TERMINAL_ID.txt"`;

test.use({
  seedOptions: {
    gitRepo: true,
    realPaths: true,
    split: false,
    presetList: [
      { id: "shell", name: "Agent", icon: "a", color: "", agent: "claude", autoResume: false, command: RECEIVER },
    ],
  },
});

const received = (projectDir: string, tab: string) => {
  const file = join(projectDir, `received-${tab}.txt`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

test("a diff comment is sent to the chosen agent pane with its place and the quoted line", async ({
  window,
  seeded,
}) => {
  const dirtyBtn = window.locator(".aya-statusbar-button", { hasText: "dirty" });
  await expect(dirtyBtn).toContainText("dirty", { timeout: 10000 });
  await dirtyBtn.click();
  const popover = window.locator(".aya-statusbar-popover");
  await popover.getByRole("button", { name: "Show diff" }).click();
  const diff = popover.locator(".aya-diff-view");
  await expect(diff).toContainText("twoX");

  // The "+" in the gutter of the changed line opens the note editor there.
  const changed = diff.locator(".aya-diff-view-line--add", { hasText: "twoX" });
  await changed.hover();
  await changed.getByRole("button", { name: /Comment on line/ }).click();
  const editor = popover.locator(".aya-diff-comment--editor textarea");
  await editor.fill("keep the old spelling here");
  await editor.press("Enter");
  await expect(popover.locator(".aya-diff-comment-note")).toHaveText("keep the old spelling here");

  // The bar names the active pane first; pick the other one and send.
  const bar = popover.getByTestId("diff-review-bar");
  await expect(bar).toContainText("1 comment");
  const select = bar.locator("select");
  await expect(select.locator("option")).toHaveText(["shell 1", "shell 2"]);
  await select.selectOption({ label: "shell 2" });
  await popover.getByTestId("diff-review-send").click();

  // The popover closes, the target pane is focused, and the prompt arrived whole.
  await expect(popover).toHaveCount(0);
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 2/);
  await expect
    .poll(() => received(seeded.projectDir, seeded.tabIds.right), { timeout: 15000 })
    .toMatch(/1\. committed\.txt:2\n.*@@ -1,2 \+1,2 @@\n.*> \+twoX\n.*keep the old spelling here/);
  expect(received(seeded.projectDir, seeded.tabIds.left)).toBe("");
});

test("a comment survives closing the popover, and Clear drops it", async ({ window }) => {
  const dirtyBtn = window.locator(".aya-statusbar-button", { hasText: "dirty" });
  await expect(dirtyBtn).toContainText("dirty", { timeout: 10000 });
  await dirtyBtn.click();
  const popover = window.locator(".aya-statusbar-popover");
  await popover.getByRole("button", { name: "Show diff" }).click();
  const diff = popover.locator(".aya-diff-view");
  const added = diff.locator(".aya-diff-view-line--add", { hasText: "brand new" });
  await added.hover();
  await added.getByRole("button", { name: /Comment on line/ }).click();
  await popover.locator(".aya-diff-comment--editor textarea").fill("drop this file");
  await popover.getByRole("button", { name: "Add", exact: true }).click();
  await expect(popover.getByTestId("diff-review-bar")).toContainText("1 comment");
  // Closing (a click on the sidebar's empty space) and reopening the popover
  // comes back to the diff view with the comment still under its line.
  const sidebar = await window.locator(".aya-sidebar").boundingBox();
  await window.mouse.click(sidebar!.x + sidebar!.width / 2, sidebar!.y + sidebar!.height / 2);
  await expect(popover).toHaveCount(0);
  await dirtyBtn.click();
  await expect(popover.locator(".aya-diff-comment-note")).toHaveText("drop this file");
  await popover.getByRole("button", { name: "Clear" }).click();
  await expect(popover.getByTestId("diff-review-bar")).toHaveCount(0);
});
