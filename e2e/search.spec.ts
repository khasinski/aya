import { test, expect, type Page } from "./fixtures";

// Buffer-content search (Cmd/Ctrl+K, ptySearch over each PTY's output buffer)
// had no behavioural e2e — only focus-on-close was covered. Search reads the
// raw PTY buffer, not the DOM, so it works in single-view despite WebGL. Each
// test below probes ONE distinct behaviour / failure mode.

test.use({ seedOptions: { split: false } }); // single-view: one active terminal at a time

async function typeInActiveTerminal(window: Page, text: string) {
  await window.locator(".aya-pane .xterm-screen").first().click();
  await window.keyboard.insertText(text);
  await window.keyboard.press("Enter");
}

async function openSearch(window: Page) {
  await window.locator('button[title^="Search"]').click();
  await expect(window.locator(".aya-search-input")).toBeVisible();
}

// Failure mode: selecting a content hit navigates to the WRONG terminal (or
// nowhere). Type a marker into the SECOND terminal, search it from the FIRST,
// select the hit, and assert the active terminal became the second one.
test("selecting a content match switches the active terminal to the one whose buffer contains it", async ({
  window,
}) => {
  await window.locator(".aya-sidebar-row", { hasText: "shell 2" }).click();
  await typeInActiveTerminal(window, "echo NAV_MARKER_BRAVO");

  await window.locator(".aya-sidebar-row", { hasText: "shell 1" }).click();
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);

  await openSearch(window);
  await window.locator(".aya-search-input").fill("NAV_MARKER_BRAVO");
  const hit = window.locator(".aya-search-row", { hasText: /NAV_MARKER_BRAVO/ });
  await expect(hit).toBeVisible();
  await hit.click();

  // The hit lived in shell 2's buffer, so selecting it must make shell 2 active.
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 2/);
});

// Failure mode: search becomes case-sensitive (a lowercase query stops matching
// uppercase output, or vice versa). searchPtyOutputs lowercases both sides.
test("a lowercase query matches uppercase terminal output (search is case-insensitive)", async ({
  window,
}) => {
  await typeInActiveTerminal(window, "echo CASEFOLD_UPPER");

  await openSearch(window);
  await window.locator(".aya-search-input").fill("casefold_upper");
  await expect(
    window.locator(".aya-search-row", { hasText: /CASEFOLD_UPPER/i }),
  ).toBeVisible();
});

// Failure mode: a no-match query shows stale rows from a previous query instead
// of the empty state. Match something first, then change to a never-present
// token and assert the list collapses to "No matches".
test("changing to a never-present query replaces stale results with the empty state", async ({
  window,
}) => {
  await typeInActiveTerminal(window, "echo TRANSIENT_HIT");

  await openSearch(window);
  const input = window.locator(".aya-search-input");
  await input.fill("TRANSIENT_HIT");
  await expect(
    window.locator(".aya-search-row", { hasText: /TRANSIENT_HIT/ }),
  ).toBeVisible();

  await input.fill("zzqq_absent_token_9137");
  await expect(window.locator(".aya-search-empty")).toBeVisible();
  await expect(window.locator(".aya-search-row")).toHaveCount(0);
});
