// The Grok chip shows a weekly-limit ring once Grok has logged its allowance.

import { test, expect } from "./fixtures";
import { USAGE_STALE_AFTER_MS } from "../src/ui-timing";

/** From app boot to the chip showing the first read of Grok's log. */
const CHIP_TIMEOUT_MS = 30_000;
/** Past the stale age: the chip re-renders once a minute, so it dims up to a minute late. */
const PAST_STALE_MS = USAGE_STALE_AFTER_MS + 5 * 60_000;
const END = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

test.use({
  seedOptions: { grokCredits: { pct: 47, end: END, ts: new Date().toISOString() } },
});

test("the Grok chip shows the logged weekly percent and its reset", async ({ window }) => {
  const chip = window.getByRole("button", { name: "Grok usage, account-wide" });
  await expect(chip).toContainText("47%", { timeout: CHIP_TIMEOUT_MS });
  await expect(chip).toHaveAttribute("title", /47% of the weekly limit/);
  await expect(chip).toHaveCSS("opacity", "1");

  await chip.click();
  const menu = window.getByRole("menu").filter({ hasText: "Grok" });
  await expect(menu).toContainText("week");
  await expect(menu).toContainText("resets");
  await expect(menu).not.toContainText("stale");
  // No turns in the week, so no model list: no bare "Grok" footer either.
  await expect(menu.getByText("Grok", { exact: true })).toHaveCount(0);
});

test.describe("an hour-old snapshot", () => {
  test.use({
    seedOptions: {
      grokCredits: { pct: 47, end: END, ts: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    },
  });

  test("is dimmed and labelled stale, since Grok logs it irregularly", async ({ window }) => {
    const chip = window.getByRole("button", { name: "Grok usage, account-wide" });
    await expect(chip).toContainText("47%", { timeout: CHIP_TIMEOUT_MS });
    await expect(chip).toHaveCSS("opacity", "0.5");
    await chip.click();
    await expect(window.getByRole("menu").filter({ hasText: "Grok" })).toContainText("stale");
  });
});

test.describe("a snapshot from yesterday", () => {
  const ts = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  test.use({ seedOptions: { grokCredits: { pct: 47, end: END, ts } } });

  test("says which day, not just a clock time that reads as today", async ({ window }) => {
    const chip = window.getByRole("button", { name: "Grok usage, account-wide" });
    await expect(chip).toContainText("47%", { timeout: CHIP_TIMEOUT_MS });
    await chip.click();
    const day = await window.evaluate(
      (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }),
      ts,
    );
    await expect(window.getByRole("menu").filter({ hasText: "Grok" })).toContainText(`updated ${day}`);
  });
});

test.describe("a fresh snapshot nobody refreshes", () => {
  test.use({ seedOptions: { grokCredits: { pct: 47, end: END, ts: new Date().toISOString() } } });

  test(`dims on its own once it is ${USAGE_STALE_AFTER_MS / 60_000} minutes old`, async ({ window }) => {
    await window.clock.install();
    await window.reload();
    const chip = window.getByRole("button", { name: "Grok usage, account-wide" });
    await expect(chip).toContainText("47%", { timeout: CHIP_TIMEOUT_MS });
    await expect(chip).toHaveCSS("opacity", "1");
    await window.clock.fastForward(PAST_STALE_MS);
    await expect(chip).toHaveCSS("opacity", "0.5");
  });
});
