import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Reproduces a user report: clicking a saved snippet in the drawer prints
//   "aya: terminal has exited — press Shift+Enter to restart, then send the
//    snippet again"
// into the terminal instead of sending it — even when the terminal is alive.
// sendSnippet (TerminalView) refuses to write whenever terminal.exitCode !== null.
//
// Default seed = 1x2 split, so panes use the DOM renderer and terminal text is
// readable from .xterm-rows. The sendSnippet guard is identical in single-view.

const firstPaneRows = ".aya-pane:first-child .xterm-rows";

async function clickFirstSnippet(window: Page) {
  await window.locator(".aya-pane-snippettoggle").first().click();
  const drawer = window.locator(".aya-snippetbar--open").first();
  await expect(drawer).toBeVisible();
  await drawer.locator(".aya-snippet").first().click();
}

// ---------------------------------------------------------------------------
// 1. Expected behaviour: a genuinely-exited terminal blocks the snippet and
//    tells the user why. This documents the guard and is correct.
// ---------------------------------------------------------------------------
test("snippet on a genuinely exited terminal shows the 'has exited' notice", async ({
  window,
}) => {
  const pane = window.locator(".aya-pane").first();
  await pane.locator(".xterm-screen").click();
  await window.keyboard.type("exit");
  await window.keyboard.press("Enter");

  await expect(window.locator(firstPaneRows)).toContainText(/process exited/i, {
    timeout: 5000,
  });

  await clickFirstSnippet(window);

  await expect(window.locator(firstPaneRows)).toContainText(
    /aya: terminal has exited/i,
    { timeout: 5000 },
  );
});

// ---------------------------------------------------------------------------
// 2. THE BUG (currently failing — marked test.fail). After right-click ->
//    Restart, the terminal is alive and accepts input, but clicking a snippet
//    is wrongly blocked as "exited". Root cause: forceRestartTerminal kills the
//    PTY, resets exitCode to null, then respawns — but the kill's asynchronous
//    onExit event arrives AFTER the reset and re-sets exitCode on the now-alive
//    respawned PTY, so sendSnippet's guard fires on a live terminal.
//    Remove test.fail() once the race is fixed.
// ---------------------------------------------------------------------------
test.fail(
  "BUG: snippet on a restarted (alive) terminal is wrongly blocked as 'exited'",
  async ({ window }) => {
    // Right-click the first sidebar row -> Restart terminal (kill + respawn).
    await window.locator(".aya-sidebar-row").first().click({ button: "right" });
    await window
      .locator(".aya-context-menu-item", { hasText: "Restart terminal" })
      .click();

    // Prove the terminal is ALIVE after the restart: the fresh shell echoes a
    // typed marker back (a dead PTY would show nothing).
    const pane = window.locator(".aya-pane").first();
    await pane.locator(".xterm-screen").click();
    await window.keyboard.type("echo ALIVE_AFTER_RESTART");
    await window.keyboard.press("Enter");
    await expect(window.locator(firstPaneRows)).toContainText(
      /ALIVE_AFTER_RESTART/,
      { timeout: 5000 },
    );

    // On a live terminal the snippet must be SENT, never blocked. This is the
    // correct behaviour the fix should restore; it currently fails because the
    // notice is printed instead.
    await clickFirstSnippet(window);
    await expect(window.locator(firstPaneRows)).not.toContainText(
      /aya: terminal has exited/i,
      { timeout: 3000 },
    );
  },
);
