import { test, expect } from "./fixtures";

// A hidden test window must not beep or ding at whoever is at the machine: launchApp mutes Chromium audio.
test("the app under test is launched with Chromium audio muted", async ({ app }) => {
  const muted = await app.evaluate(({ app: electronApp }) => electronApp.commandLine.hasSwitch("mute-audio"));
  expect(muted).toBe(true);
});
