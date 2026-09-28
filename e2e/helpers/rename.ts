import { expect, type Locator } from "@playwright/test";

/** Double-click `name` to open the inline editor `input`, type `value`, Enter.
 *  Retried whole: a cold first render can swallow the double-click, and the
 *  launch-time focus grab can blur the editor the instant it opens. */
export async function renameInline(name: Locator, input: Locator, value: string) {
  await expect(async () => {
    await name.dblclick();
    await input.fill(value, { timeout: 800 });
    await input.press("Enter", { timeout: 800 });
  }).toPass({ timeout: 15000 });
}
