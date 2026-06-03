import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

// End-to-end coverage for issue #4 (config-file watcher) and the SettingsModal
// clobber fix found in review. An external hand-edit to snippets.json while Aya
// runs must (a) reach the renderer via the watcher -> IPC -> setSnippets path,
// and (b) survive an unrelated in-app Save instead of being overwritten by the
// modal's stale draft. The drawer renders the live `snippets` state, so a
// renamed snippet shows up in `.aya-snippet-name` without opening Settings.

/** Write a single-snippet snippets.json into the seeded AYA_HOME, matching the
 *  on-disk shape `{ snippets: [...] }` the app reads. */
function writeSnippetsFile(ayaHome: string, name: string) {
  writeFileSync(
    join(ayaHome, "snippets.json"),
    JSON.stringify(
      {
        snippets: [
          { id: "ext-edit", name, text: "echo hot reload", autoRun: false },
        ],
      },
      null,
      2,
    ) + "\n",
  );
}

/** Read snippets.json back from disk and return the snippet names, so a test can
 *  assert the externally-edited entry was not clobbered by an in-app Save. */
function readSnippetNames(ayaHome: string): string[] {
  const raw = readFileSync(join(ayaHome, "snippets.json"), "utf-8");
  return (JSON.parse(raw).snippets as { name: string }[]).map((s) => s.name);
}

test("an external snippets.json edit is not clobbered when Settings is open and saved", async ({
  window,
  app,
  seeded,
}) => {
  // The seeded AYA_HOME ships no snippets file, so the app seeds DEFAULT_SNIPPETS
  // on boot. Open the drawer and confirm that default before touching anything.
  await window.locator(".aya-pane-snippettoggle").first().click();
  const drawer = window.locator(".aya-snippetbar--open").first();
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: "magic numbers audit" }),
  ).toBeVisible();

  // Open Settings WHILE the snippet draft still holds the default. This ordering
  // is the crux of the regression: the modal seeds its editable draft once at
  // mount, so it must start from the default — only then does a hot-reload the
  // draft fails to track become observable as a clobber on Save. (Opening
  // Settings AFTER the edit would seed the draft straight to the marker and pass
  // even on the buggy code.)
  await fireShortcut(app, "open-settings");
  await expect(window.locator(".aya-modal--settings")).toBeVisible();

  // Now hand-edit snippets.json from outside the app (renamed to a unique marker).
  const MARKER = "external marker reload";
  writeSnippetsFile(seeded.ayaHome, MARKER);

  // The watcher -> IPC -> setSnippets path updates App state, so the live drawer
  // (rendered behind the modal) reflects the marker and the old default is gone.
  // This proves the reload path end to end; it passes with or without the fix.
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: MARKER }),
  ).toBeVisible();
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: "magic numbers audit" }),
  ).toHaveCount(0);

  // Make an UNRELATED change (switch the active theme) and Save. handleSave must
  // not rewrite snippets.json from a stale draft: the fix skips the untouched
  // snippets write (snippetsDirty === false) and re-syncs the draft to the
  // marker; the pre-fix code unconditionally re-serialized the stale default.
  await window
    .locator(".aya-theme-row", { hasText: "Tokyo Night" })
    .locator("input[type=radio]")
    .check();
  await window.locator(".aya-modal-btn", { hasText: "Save" }).click();
  await expect(window.locator(".aya-modal--settings")).toHaveCount(0);

  // The clobber regression guard. Pre-fix this is ["magic numbers audit"]
  // (the stale draft overwrote disk); with the fix it stays [MARKER].
  await expect
    .poll(() => readSnippetNames(seeded.ayaHome), {
      message: "the externally-edited snippet must survive an unrelated in-app Save",
    })
    .toEqual([MARKER]);

  // ...and still visible in the live drawer.
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: MARKER }),
  ).toBeVisible();
});

test("an invalid hand-edit is handled gracefully and keeps the last good state", async ({
  window,
  seeded,
}) => {
  await expect(window.locator(".aya-pane")).toHaveCount(2);
  await window.locator(".aya-pane-snippettoggle").first().click();
  const drawer = window.locator(".aya-snippetbar--open").first();

  // First a VALID external edit, asserted live. This is a real sync barrier: it
  // proves the watcher is actually firing in this run, so the invalid write
  // below is genuinely observed rather than a no-op the assertion sails through.
  const GOOD = "valid before invalid";
  writeSnippetsFile(seeded.ayaHome, GOOD);
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: GOOD }),
  ).toBeVisible();

  // Now a malformed file. The watcher still fires; the main-side loader rejects
  // the JSON parse and the renderer's .catch keeps current state instead of an
  // unhandled rejection / white-screen. Settle past the 200ms watch debounce so
  // the invalid write is actually processed, then assert the UI kept the last
  // good value and stayed responsive (no clobber to empty, no crash).
  writeFileSync(join(seeded.ayaHome, "snippets.json"), "{ this is not json");
  await window.waitForTimeout(400);
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: GOOD }),
  ).toBeVisible();
  await expect(window.locator(".aya-pane")).toHaveCount(2);
});
