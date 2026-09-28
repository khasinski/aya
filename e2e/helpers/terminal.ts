import { expect, type Locator, type Page } from "@playwright/test";

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

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Clears the screen of the pane `host` belongs to and prints `payload` (printf %b escapes). */
export async function writeTerminalOutput(host: Locator, payload: string) {
  const command = `printf %b ${shellSingleQuote(`\\033[2J\\033[H${payload}`)}`;
  await host.click();
  await host.page().keyboard.insertText(command);
  await host.page().keyboard.press("Enter");
}

/** Every terminal pane currently shown. */
export const visiblePanes = (window: Page) => window.locator('[data-testid="terminal-pane"]:visible');

/** The shown pane of terminal `name`. */
export const visiblePane = (window: Page, name: string) =>
  window.locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]:visible`);

/** The split cell of terminal `name`, if it carries the active-cell marker. */
export const activeSplitPane = (window: Page, name: string) =>
  window.locator(`.aya-pane--active-split[data-terminal-name="${name}"]`);

/** The name of the terminal pane holding keyboard focus, or null. */
export const focusedTerminalName = (window: Page) =>
  window.evaluate(
    () =>
      document.activeElement
        ?.closest('[data-testid="terminal-pane"]')
        ?.getAttribute("data-terminal-name") ?? null,
  );
