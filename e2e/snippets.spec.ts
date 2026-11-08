import { test, expect, launchApp, closeAndWait } from "./fixtures";
import { seedEnv } from "./helpers/seed";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// The snippet drawer end to end: it opens from the pane header, shows the
// seeded default snippet with its full text, and collapses after a send so the
// terminal result stays visible.

test("snippet drawer opens, shows the seeded default, and collapses after sending", async ({
  window,
}) => {
  // The fresh AYA_HOME has no snippets file, so the app seeds DEFAULT_SNIPPETS
  // on boot. Open the first pane's drawer.
  await window.getByTestId("snippet-toggle").first().click();

  const drawer = window.getByTestId("snippet-drawer").first();
  await expect(drawer).toBeVisible();

  // Seeded default renders with its name AND its full text (the point of the
  // drawer: verify a prompt before sending).
  await expect(
    drawer.getByTestId("snippet-name").filter({ hasText: "magic numbers audit" }),
  ).toBeVisible();
  await expect(drawer.getByTestId("snippet-text").first()).toContainText(
    "Run a full magic-numbers audit",
  );

  // Sending collapses the drawer (no open drawer remains anywhere).
  await drawer.getByTestId("snippet-item").first().click();
  await expect(window.locator(".aya-snippetbar--open")).toHaveCount(0);
});

test("closed snippet drawer is inert (cannot be tab-focused or clicked)", async ({
  window,
}) => {
  // Regression guard for the F14 ghost-drawer fix: while closed, the drawer's
  // buttons must be removed from the a11y/tab tree (inert), so they can't steal
  // focus or clicks over the status bar.
  const closedDrawer = window.getByTestId("snippet-drawer").first();
  await expect(closedDrawer).not.toHaveClass(/aya-snippetbar--open/);
  await expect(closedDrawer).toHaveAttribute("inert", "");
});

test("snippet drawer settings button opens the Snippets settings tab", async ({
  window,
}) => {
  await window.getByTestId("snippet-toggle").first().click();

  const drawer = window.getByTestId("snippet-drawer").first();
  await drawer.getByTestId("snippet-settings-button").click();

  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await expect(
    settings.getByTestId("settings-tab").filter({ hasText: "Snippets" }),
  ).toBeVisible();
  await expect(settings.locator(".aya-modal-title", { hasText: "Snippets" })).toBeVisible();
});

test("snippets work in a conversation GUI, including a running agent's queue", async ({}, testInfo) => {
  const seed = seedEnv({
    singleTab: { presetId: "gui", name: "Codex GUI" },
    presetList: [{ id: "gui", name: "Codex GUI", icon: "◆", color: "", command: "codex", agent: "codex", interfaceMode: "gui" }],
    snippetList: [
      { id: "hold", name: "Insert text", text: "saved", autoRun: false },
      { id: "run", name: "Send request", text: "widgets", autoRun: true },
    ],
  });
  const bin = join(seed.root, "gui-bin"); mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-codex-gui.cjs"), join(bin, "codex")); chmodSync(join(bin, "codex"), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, "codex") };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow(), gui = page.locator(".aya-conversation");
    const prompt = gui.getByRole("textbox", { name: "Message Codex" });
    await expect(gui.locator("header").getByRole("status")).toHaveText("Ready");
    await prompt.fill("Alpha omega");
    await prompt.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(6, 11));
    await page.getByTestId("snippet-toggle").click();
    const drawer = gui.getByTestId("snippet-drawer");
    await expect(drawer).toBeVisible();
    await drawer.screenshot({ path: testInfo.outputPath("gui-snippets.png"), animations: "disabled" });
    await drawer.getByTestId("snippet-item").filter({ hasText: "Insert text" }).click();
    await expect(prompt).toHaveValue("Alpha saved");
    await expect(prompt).toBeFocused();
    await expect(gui.locator("article.user")).toHaveCount(0);
    await expect(drawer).not.toHaveClass(/aya-snippetbar--open/);

    await page.getByTestId("snippet-toggle").click();
    await drawer.getByTestId("snippet-settings-button").click();
    const settings = page.locator(".aya-modal--settings");
    await expect(settings.locator(".aya-modal-title", { hasText: "Snippets" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await drawer.getByTitle("Close", { exact: true }).click();
    await expect(prompt).toHaveValue("Alpha saved");

    await prompt.fill("");
    await page.getByTestId("snippet-toggle").click();
    await drawer.getByTestId("snippet-item").filter({ hasText: "Send request" }).click();
    await expect(gui.locator("article.user").last()).toContainText("widgets");
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");

    await prompt.fill("wait"); await prompt.press("Enter");
    await expect(gui.getByRole("status", { name: "Turn status" })).toContainText("working");
    await page.getByTestId("snippet-toggle").click();
    await drawer.getByTestId("snippet-item").filter({ hasText: "Send request" }).click();
    await expect(gui.getByRole("textbox", { name: "Queued message 1" })).toHaveValue("widgets");
    await gui.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(gui.getByText("Queue paused")).toBeVisible();
    await gui.getByRole("button", { name: "Resume queue" }).click();
    await expect(gui.getByRole("textbox", { name: "Queued message 1" })).toHaveCount(0);
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");

    // The agent may finish before the start request is acknowledged. Clicking
    // an auto-run snippet in that gap must queue it rather than dropping it.
    await prompt.fill("complete-before-ack"); await prompt.press("Enter");
    await expect(gui.getByRole("status", { name: "Turn status" })).toContainText("working");
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
    await page.getByTestId("snippet-toggle").click();
    await drawer.getByTestId("snippet-item").filter({ hasText: "Send request" }).click();
    await expect(gui.locator("article.user").filter({ hasText: "widgets" })).toHaveCount(3, { timeout: 8000 });
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");

    await prompt.fill("disconnect-approval"); await prompt.press("Enter");
    await expect(gui.locator("header").getByRole("status")).toHaveText("Disconnected");
    await page.getByTestId("snippet-toggle").click();
    await drawer.getByTestId("snippet-item").filter({ hasText: "Send request" }).click();
    await expect(prompt).toHaveValue("widgets");
    await expect(gui.getByRole("alert")).toContainText("The snippet was added to your message");
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
