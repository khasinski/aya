import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function writeTerminalOutput(window: Page, payload: string) {
  const command = `printf %b ${shellSingleQuote(`\\033[2J\\033[H${payload}`)}\r`;
  await window.locator(".aya-pane:visible .aya-xterm-host").first().click();
  await window.keyboard.insertText(command);
}

async function renderedRows(window: Page) {
  return window.evaluate(() =>
    Array.from(document.querySelectorAll(".aya-pane"))
      .filter((pane) => getComputedStyle(pane).display !== "none")
      .flatMap((pane) => Array.from(pane.querySelectorAll(".xterm-rows > div")))
      .map((row) => row.textContent ?? "")
      .filter((text) => text.trim().length > 0),
  );
}

async function renderedSpanStyles(
  window: Page,
  text: string,
) {
  return window.evaluate((needle) => {
    const spans = Array.from(
      Array.from(document.querySelectorAll(".aya-pane"))
        .filter((pane) => getComputedStyle(pane).display !== "none")
        .flatMap((pane) => Array.from(pane.querySelectorAll(".xterm-rows span"))),
    );
    const span = spans.find((el) => (el.textContent ?? "").includes(needle));
    if (!span) return null;
    const style = getComputedStyle(span);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontWeight: style.fontWeight,
      textDecoration: style.textDecorationLine,
    };
  }, text);
}

test("SGR truecolor, background color, and resets render without bleeding", async ({
  window,
}) => {
  await writeTerminalOutput(
    window,
    "\\033[38;2;12;34;56mAYA_RGB_FG\\033[48;2;1;2;3mAYA_RGB_BG\\033[0m AYA_PLAIN\\n",
  );

  await expect.poll(() => renderedRows(window)).toContainEqual(
    expect.stringContaining("AYA_RGB_FGAYA_RGB_BG AYA_PLAIN"),
  );

  await expect.poll(() => renderedSpanStyles(window, "AYA_RGB_FG")).toMatchObject({
    color: "rgb(12, 34, 56)",
  });
  await expect.poll(() => renderedSpanStyles(window, "AYA_RGB_BG")).toMatchObject({
    backgroundColor: "rgb(1, 2, 3)",
  });
  await expect.poll(() => renderedSpanStyles(window, "AYA_PLAIN")).not.toMatchObject({
    color: "rgb(12, 34, 56)",
    backgroundColor: "rgb(1, 2, 3)",
  });
});

test("OSC title accepts BEL and ST terminators without leaking payload text", async ({
  window,
}) => {
  await writeTerminalOutput(
    window,
    "\\033]0;AYA_TITLE_BEL\\007\\033]2;AYA_TITLE_ST\\033\\\\AYA_AFTER_OSC\\n",
  );

  await expect.poll(() => renderedRows(window)).toContainEqual(
    expect.stringContaining("AYA_AFTER_OSC"),
  );
  await expect.poll(() => renderedRows(window)).not.toContainEqual(
    expect.stringContaining("AYA_TITLE_BEL"),
  );
  await expect.poll(() => renderedRows(window)).not.toContainEqual(
    expect.stringContaining("AYA_TITLE_ST"),
  );
});

test("alternate screen enter/exit restores the normal screen", async ({ window }) => {
  await writeTerminalOutput(window, "\\033[?1049hAYA_ALT_SCREEN\\n\\033[?1049lAYA_AFTER_ALT\\n");

  await expect.poll(() => renderedRows(window)).toContainEqual(
    expect.stringContaining("AYA_AFTER_ALT"),
  );
  await expect.poll(() => renderedRows(window)).not.toContainEqual(
    expect.stringContaining("AYA_ALT_SCREEN"),
  );
});

test("cursor addressing and erase-in-display handle TUI-style redraws", async ({
  window,
}) => {
  await writeTerminalOutput(
    window,
    "\\033[2J\\033[HAYA_TOP\\nAYA_OLD_STATUS\\033[2;1H\\033[2KAYA_NEW_STATUS\\n",
  );

  await expect.poll(() => renderedRows(window)).toContainEqual(
    expect.stringContaining("AYA_TOP"),
  );
  await expect.poll(() => renderedRows(window)).toContainEqual(
    expect.stringContaining("AYA_NEW_STATUS"),
  );
  await expect.poll(() => renderedRows(window)).not.toContainEqual(
    expect.stringContaining("AYA_OLD_STATUS"),
  );
});
