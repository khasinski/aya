import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

// End-to-end coverage for the config-file watcher and the SettingsModal fix.
// When snippets.json is edited by hand while Aya is running, the change must
// (a) reach the renderer through the watcher -> IPC -> setSnippets path, and
// (b) survive an unrelated Save in the app instead of being overwritten by the
// modal's old draft. The drawer shows the live `snippets` state, so a renamed
// snippet appears in `.aya-snippet-name` without opening Settings.

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
 *  check the edit made outside the app survived a Save. */
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

  // Open Settings WHILE the snippet draft still holds the default. The order
  // matters: the modal sets up its editable draft once when it mounts, so it
  // must start from the default. Only then can a reload the draft doesn't pick
  // up show up as the draft overwriting disk on Save. (Opening Settings after
  // the edit would set the draft straight to the marker and pass even with the
  // bug present.)
  await fireShortcut(app, "open-settings");
  await expect(window.locator(".aya-modal--settings")).toBeVisible();

  // Now hand-edit snippets.json from outside the app (renamed to a unique marker).
  const MARKER = "external marker reload";
  writeSnippetsFile(seeded.ayaHome, MARKER);

  // The watcher -> IPC -> setSnippets path updates App state, so the live drawer
  // (rendered behind the modal) shows the marker and the old default is gone.
  // This proves the reload path end to end; it passes with or without the fix.
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: MARKER }),
  ).toBeVisible();
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: "magic numbers audit" }),
  ).toHaveCount(0);

  // Make an UNRELATED change (switch the active theme) and Save. Saving must not
  // rewrite snippets.json from an old draft: the fix skips the untouched snippets
  // write (snippetsDirty === false) and re-syncs the draft to the marker, while
  // the old code always wrote the stale default back out.
  await window.locator(".aya-settings-tab", { hasText: "Themes" }).click();
  await window
    .locator(".aya-theme-row", { hasText: "Tokyo Night" })
    .locator("input[type=radio]")
    .check();
  await window.locator(".aya-modal-btn", { hasText: "Save" }).click();
  await expect(window.locator(".aya-modal--settings")).toHaveCount(0);

  // The actual regression guard. Without the fix this is ["magic numbers audit"]
  // (the old draft overwrote disk); with the fix it stays [MARKER].
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

  // First a VALID edit from outside, checked live. This makes sure the watcher
  // is really firing in this run, so the invalid write below is actually seen
  // and not just a no-op the assertion would pass over.
  const GOOD = "valid before invalid";
  writeSnippetsFile(seeded.ayaHome, GOOD);
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: GOOD }),
  ).toBeVisible();

  // Now a broken file. The watcher still fires; the loader fails to parse the
  // JSON and the renderer's .catch keeps the current state instead of throwing
  // an unhandled rejection or showing a white screen. Wait past the 200ms watch
  // debounce so the bad write is processed, then check the UI kept the last good
  // value and stayed responsive (it didn't blank out or crash).
  writeFileSync(join(seeded.ayaHome, "snippets.json"), "{ this is not json");
  await window.waitForTimeout(400);
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: GOOD }),
  ).toBeVisible();
  await expect(window.locator(".aya-pane")).toHaveCount(2);
});
