import { expect, type Page } from "@playwright/test";

/** Wait until the visible pane's shell has drawn something - its prompt - and is
 *  therefore reading input.
 *
 *  Type-ahead into an interactive shell that has not finished starting is not
 *  reliably delivered: the bytes reach the tty, but a shell still initializing
 *  its line editor can discard whatever was queued before ZLE came up. A real
 *  terminal behaves the same way, so this is a property of the shell, not
 *  something the app can paper over - the test has to wait for the prompt.
 *
 *  Reads the PTY's own output buffer (the same source search queries) rather
 *  than the DOM: with the WebGL renderer the pane's text is not in the DOM at
 *  all. */
export async function waitForShellReady(window: Page) {
  const pane = window.locator('[data-testid="terminal-pane"]:visible').first();
  await expect(pane).toBeVisible();
  const terminalId = await pane.getAttribute("data-terminal-id");
  expect(terminalId, "the visible pane must expose its terminal id").toBeTruthy();

  await expect
    .poll(
      () => window.evaluate((id) => window.aya.ptyBuffer(id).then((b) => b.length), terminalId!),
      { message: `shell in ${terminalId} never produced a prompt` },
    )
    .toBeGreaterThan(0);
}
