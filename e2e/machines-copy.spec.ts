import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { seedBase, THREE_MACHINES } from "./helpers/machines";

// The machines popover's text can be selected and copied, unlike the rest of the status bar.
// It uses the system clipboard, so it runs with the shared-resources specs (playwright.config.ts).

test.use({ seedOptions: { ...seedBase, ayaHomeFiles: { ...seedBase.ayaHomeFiles, "machines.json": THREE_MACHINES } } });

test("what the machines popover shows can be selected and copied with Cmd+C", async ({ app, window }) => {
  await window.getByTestId("machines-toggle").click();
  const line = window.getByRole("dialog", { name: "Machines" }).getByText("qwen3:32b", { exact: false });
  await line.click({ clickCount: 3 });
  expect(await window.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("qwen3:32b");
  await app.evaluate(({ clipboard }) => clipboard.writeText(""));
  await window.keyboard.press("Meta+c");
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain("qwen3:32b · 19.6 GB");
});
