// src/types.ts and electron/text.ts hold the same normalizer because electron/
// never imports from src/. uniqueProjectName uses the renderer copy to predict
// the slug createProject assigns, and createProject throws rather than dedupe -
// so a divergence, fallback included, gets a valid name rejected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { slugifyName as rendererSlugify } from "../dist-test/types.js";
import { slugifyName as mainSlugify } from "../dist-electron/text.js";

const AYA_HOME = mkdtempSync(join(tmpdir(), "aya-slug-parity-"));
process.env.AYA_HOME = AYA_HOME;
const { createProject } = await import("../dist-electron/config.js");

const EMPTY_NORMALIZING = ["###", "---", "...", "ąę", "日本語", "", "   "];
const NAMES = [
  "My Project",
  "aya",
  "  spaced  ",
  "a-b_c",
  "2026",
  "UPPER Case",
  "trailing---",
  "---leading",
  ...EMPTY_NORMALIZING,
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

test("a name that normalizes to nothing takes the fallback on both sides", () => {
  for (const name of EMPTY_NORMALIZING) {
    assert.equal(rendererSlugify(name, "project"), "project", name);
    assert.equal(mainSlugify(name, "project"), "project", name);
  }
});

test("two different empty-normalizing names collide on one project slug", async () => {
  const first = await createProject("###", "/srv/work/hash");
  assert.equal(first.slug, "project");

  await assert.rejects(
    () => createProject("ąę", "/srv/work/diacritics"),
    /already exists/,
    "a second empty-normalizing name must collide on the same slug",
  );
});

test.after(() => {
  rmSync(AYA_HOME, { recursive: true, force: true });
});
