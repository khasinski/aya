// The name -> slug normalizer is declared twice on purpose (electron/ never
// imports from src/): src/types.ts slugifyName for the renderer,
// electron/text.ts slugifyName for the main process. This pins them together.
//
// It is not cosmetic. src/App.tsx's uniqueProjectName uses the renderer copy to
// PREDICT the slug electron/config.ts createProject will assign, and
// createProject does not de-duplicate - it throws. So any divergence, including
// in the fallback, makes the renderer hand over a name that is then rejected.
// The two copies really had diverged: the renderer's presetSlug fell back to
// "preset" where main falls back to "project", which differs for every name
// that normalizes to nothing (e.g. "###", "ąę", "日本語").
//
// AYA_HOME is redirected before the dynamic config import so paths.ts resolves
// against a throwaway home; node --test isolates per file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { slugifyName as rendererSlugify } from "../dist-test/types.js";
import { slugifyName as mainSlugify } from "../dist-electron/text.js";

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-slug-parity-"));
const { createProject } = await import("../dist-electron/config.js");

// Names that reduce to nothing are the whole point: that is where the two
// copies used to disagree. The rest guard the ordinary path.
const NAMES = [
  "My Project",
  "aya",
  "  spaced  ",
  "a-b_c",
  "2026",
  "UPPER Case",
  "trailing---",
  "---leading",
  "###",
  "---",
  "...",
  "ąę",
  "日本語",
  "",
  "   ",
];

test("renderer and main slugify identically, fallback included", () => {
  for (const name of NAMES) {
    for (const fallback of ["project", "preset"]) {
      assert.equal(
        rendererSlugify(name, fallback),
        mainSlugify(name, fallback),
        `slug drift for ${JSON.stringify(name)} with fallback "${fallback}"`,
      );
    }
  }
});

test("a name that normalizes to nothing takes the fallback, not a mangled slug", () => {
  // Pins the behaviour the collision below depends on: both copies must agree
  // that these collapse to the fallback rather than to "" or "-".
  for (const name of ["###", "---", "ąę", "", "   "]) {
    assert.equal(rendererSlugify(name, "project"), "project", name);
    assert.equal(mainSlugify(name, "project"), "project", name);
  }
});

test("two different empty-normalizing names collide on one project slug", async () => {
  // The failure the renderer has to predict: distinct display names, one slug.
  // createProject is strict, so the second create is rejected - which is why
  // uniqueProjectName must compute the slug with main's "project" fallback.
  const first = await createProject("###", "/srv/work/hash");
  assert.equal(first.slug, "project");

  await assert.rejects(
    () => createProject("ąę", "/srv/work/diacritics"),
    /already exists/,
    "a second empty-normalizing name must collide on the same slug",
  );
});

test("the renderer predicts the slug createProject actually assigned", () => {
  // The end-to-end invariant in one line: what uniqueProjectName checks against
  // the existing slug set is what main stored.
  assert.equal(rendererSlugify("###", "project"), "project");
});
