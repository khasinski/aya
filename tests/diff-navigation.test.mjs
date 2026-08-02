// Covers diffFileLineIndex — the matcher behind "click a changed file → jump
// to its section in the status-bar diff". The tricky bits are matching the
// b-side path (so renames land on the new name), not false-matching on a path
// suffix, and only matching real `diff --git` headers (never content lines).

import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFileLineIndex } from "../dist-test/diff-navigation.js";

const TWO_FILES = [
  "diff --git a/src/App.tsx b/src/App.tsx", // 0
  "index 1111111..2222222 100644", // 1
  "--- a/src/App.tsx", // 2
  "+++ b/src/App.tsx", // 3
  "@@ -1,2 +1,2 @@", // 4
  "-old", // 5
  "+new", // 6
  "diff --git a/electron/main.ts b/electron/main.ts", // 7
  "index 3333333..4444444 100644", // 8
  "--- a/electron/main.ts", // 9
  "+++ b/electron/main.ts", // 10
  "@@ -1 +1 @@", // 11
  "+added", // 12
].join("\n");

test("finds the first file's header line", () => {
  assert.equal(diffFileLineIndex(TWO_FILES, "src/App.tsx"), 0);
});

test("finds a later file's header line", () => {
  assert.equal(diffFileLineIndex(TWO_FILES, "electron/main.ts"), 7);
});

test("returns -1 for an empty path", () => {
  assert.equal(diffFileLineIndex(TWO_FILES, ""), -1);
});

test("returns -1 when the file isn't in the diff", () => {
  assert.equal(diffFileLineIndex(TWO_FILES, "src/Nope.tsx"), -1);
});

test("returns -1 for an empty diff", () => {
  assert.equal(diffFileLineIndex("", "src/App.tsx"), -1);
});

test("matches the b-side path on a rename", () => {
  const diff = [
    "diff --git a/old/name.ts b/new/name.ts",
    "similarity index 90%",
    "rename from old/name.ts",
    "rename to new/name.ts",
  ].join("\n");
  assert.equal(diffFileLineIndex(diff, "new/name.ts"), 0);
  // The old path no longer locates anything — it's the a-side.
  assert.equal(diffFileLineIndex(diff, "old/name.ts"), -1);
});

test("does not false-match a path that is a suffix of another", () => {
  const diff = [
    "diff --git a/pkg/foo.ts b/pkg/foo.ts", // 0
    "@@ -1 +1 @@", // 1
    "+a", // 2
    "diff --git a/foo.ts b/foo.ts", // 3
    "@@ -1 +1 @@", // 4
    "+b", // 5
  ].join("\n");
  // "foo.ts" must resolve to the top-level file, not pkg/foo.ts.
  assert.equal(diffFileLineIndex(diff, "foo.ts"), 3);
  assert.equal(diffFileLineIndex(diff, "pkg/foo.ts"), 0);
});

test("only matches real diff headers, not content lines mentioning b/<path>", () => {
  const diff = [
    "diff --git a/readme.md b/readme.md", // 0
    "@@ -1 +1 @@", // 1
    "+see also b/foo.ts in the tree", // 2 — content, must be ignored
    "diff --git a/foo.ts b/foo.ts", // 3 — the real header
    "@@ -1 +1 @@", // 4
    "+x", // 5
  ].join("\n");
  assert.equal(diffFileLineIndex(diff, "foo.ts"), 3);
});

test("matches a synthetic untracked-file header", () => {
  const diff = [
    "diff --git a/new file.txt b/new file.txt", // paths with spaces
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    "+++ b/new file.txt",
    "@@ -0,0 +1,1 @@",
    "+hello",
  ].join("\n");
  assert.equal(diffFileLineIndex(diff, "new file.txt"), 0);
});
