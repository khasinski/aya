// The Doherty threshold: a command's visible result within 400 ms, or the user's flow breaks. Each case times, inside
// the renderer, from the real input event to the first frame that shows the result. This file runs in the serial
// project (playwright.config.ts), so seven other Electron instances do not inflate the numbers.
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";

const DOHERTY_MS = 400;
/** One sample may hit a first mount or a GC pause; twice the threshold is where a stall stops being a blip. */
const WORST_SAMPLE_MS = 2 * DOHERTY_MS;

type Done = {
  /** Rendered elements matching this must exist... */
  selector: string;
  /** ...at least this many (default 1)... */
  minCount?: number;
  /** ...and, when set, the visible terminal pane must be another one than before the input. */
  paneChanged?: boolean;
};

/** Arm a timer in the renderer, run `act` (a real click or key), and return input-event-to-frame milliseconds. */
async function latency(page: Page, act: () => Promise<unknown>, done: Done): Promise<number> {
  await page.evaluate((expected) => {
    const visiblePane = (): string | undefined =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="terminal-pane"]')].find((pane) => pane.getClientRects().length)?.dataset.terminalId;
    const before = visiblePane();
    const shown = (): boolean => {
      const rendered = [...document.querySelectorAll<HTMLElement>(expected.selector)].filter((el) => el.getClientRects().length);
      return rendered.length >= (expected.minCount ?? 1) && (!expected.paneChanged || visiblePane() !== before);
    };
    (window as unknown as { __latency: Promise<number> }).__latency = new Promise<number>((resolve, reject) => {
      const begin = (event: Event): void => {
        document.removeEventListener("pointerdown", begin, true);
        document.removeEventListener("keydown", begin, true);
        // The event's own timestamp, so time spent queued behind a busy main thread counts.
        const start = event.timeStamp;
        const giveUp = setTimeout(() => reject(new Error(`No result within 10 s for ${expected.selector}`)), 10_000);
        const check = (): void => {
          if (!shown()) { requestAnimationFrame(check); return; }
          // One more frame: the result is in the DOM now, and painted when this callback runs.
          requestAnimationFrame(() => { clearTimeout(giveUp); resolve(performance.now() - start); });
        };
        check();
      };
      document.addEventListener("pointerdown", begin, true);
      document.addEventListener("keydown", begin, true);
    });
  }, done);
  await act();
  return page.evaluate(() => (window as unknown as { __latency: Promise<number> }).__latency);
}

async function expectWithinDoherty(testInfo: TestInfo, name: string, samples: number[]): Promise<void> {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];
  // In the run's output too: a pass leaves no attachment behind, and the trend is worth seeing.
  console.log(`[latency] ${name}: median ${Math.round(median)} ms, worst ${Math.round(worst)} ms (${samples.map((ms) => Math.round(ms)).join(", ")})`);
  await testInfo.attach(`${name}.json`, { body: JSON.stringify({ name, samples, median, worst }), contentType: "application/json" });
  expect(median, `${name}: median of ${samples.map((ms) => Math.round(ms)).join(", ")} ms`).toBeLessThan(DOHERTY_MS);
  expect(worst, `${name}: worst of ${samples.map((ms) => Math.round(ms)).join(", ")} ms`).toBeLessThan(WORST_SAMPLE_MS);
}

test.describe("commands answer within the Doherty threshold", () => {
  test.use({ seedOptions: { split: false, secondProject: true } });

  test("switching terminals", async ({ window }, testInfo) => {
    const rows = window.getByRole("list", { name: "Terminals" }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    const samples: number[] = [];
    for (const index of [1, 0, 1, 0, 1, 0]) {
      samples.push(await latency(window, () => rows.nth(index).click(), { selector: '[role="list"][aria-label="Terminals"] [aria-current="true"]', paneChanged: true }));
      await expect(rows.nth(index)).toHaveAttribute("aria-current", "true");
    }
    await expectWithinDoherty(testInfo, "switch-terminal", samples);
  });

  test("switching projects", async ({ window }, testInfo) => {
    const tabs = window.getByRole("tablist", { name: "Projects" }).getByRole("tab");
    await expect(tabs).toHaveCount(2);
    const samples: number[] = [];
    for (const index of [1, 0, 1, 0, 1, 0]) {
      samples.push(await latency(window, () => tabs.nth(index).click(), { selector: '[role="tablist"][aria-label="Projects"] [role="tab"][aria-selected="true"]', paneChanged: true }));
      await expect(tabs.nth(index)).toHaveAttribute("aria-selected", "true");
    }
    await expectWithinDoherty(testInfo, "switch-project", samples);
  });

  test("opening settings", async ({ window }, testInfo) => {
    const settings = window.locator(".aya-modal--settings");
    const samples: number[] = [];
    for (let round = 0; round < 4; round++) {
      samples.push(await latency(window, () => window.getByRole("button", { name: "Settings", exact: true }).click(), { selector: ".aya-modal--settings" }));
      await expect(settings).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(settings).toBeHidden();
    }
    await expectWithinDoherty(testInfo, "open-settings", samples);
  });

  test("a new terminal's row and pane", async ({ window }, testInfo) => {
    const rows = window.getByRole("list", { name: "Terminals" }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    const samples: number[] = [];
    for (let count = 3; count <= 6; count++) {
      // The row and the pane, not the shell's first prompt: how fast a login shell starts is not Aya's latency.
      samples.push(await latency(window, () => window.locator(".aya-launcher .aya-launcher-btn", { hasText: "Shell" }).click(), {
        selector: '[role="list"][aria-label="Terminals"] [role="listitem"]', minCount: count, paneChanged: true,
      }));
      await expect(rows).toHaveCount(count);
    }
    await expectWithinDoherty(testInfo, "new-terminal", samples);
  });
});
