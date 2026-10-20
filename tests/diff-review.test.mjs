import { test } from "node:test";
import assert from "node:assert/strict";
import { commentRowIndex, isCommentOutdated, locateDiffLine } from "../dist-test/diff-review.js";
import { MAX_DIFF_REVIEW_PROMPT_BYTES, reviewPrompt, reviewPtyPayload } from "../dist-electron/diff-comments-prompt.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ function a() {
 keep one
-old two
+new two
+new three
 keep four
@@ -40,2 +41,2 @@ function b() {
 keep forty
-gone
+here
diff --git a/README.md b/README.md
deleted file mode 100644
index 3333333..0000000
--- a/README.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# Title
-text
`;
const lines = DIFF.split("\n");
const row = (text) => lines.indexOf(text);
const comment = (anchor, note = "why") => ({
  ...anchor, id: "0123456789abcdef", checkout: "/work/proj", note,
  createdAt: "2026-01-01T00:00:00.000Z", sentAt: null, sentTo: null,
});

test("locateDiffLine numbers additions, removals and context from each hunk", () => {
  assert.deepEqual(locateDiffLine(lines, row(" keep one")), {
    file: "src/a.ts", hunk: "@@ -10,4 +10,5 @@ function a() {", line: " keep one", newLine: 10, oldLine: 10, occurrence: 0,
  });
  assert.deepEqual(locateDiffLine(lines, row("-old two")), {
    file: "src/a.ts", hunk: "@@ -10,4 +10,5 @@ function a() {", line: "-old two", newLine: null, oldLine: 11, occurrence: 0,
  });
  assert.deepEqual(locateDiffLine(lines, row("+new three")), {
    file: "src/a.ts", hunk: "@@ -10,4 +10,5 @@ function a() {", line: "+new three", newLine: 12, oldLine: null, occurrence: 0,
  });
  assert.deepEqual(locateDiffLine(lines, row(" keep four")), {
    file: "src/a.ts", hunk: "@@ -10,4 +10,5 @@ function a() {", line: " keep four", newLine: 13, oldLine: 12, occurrence: 0,
  });
  assert.deepEqual(locateDiffLine(lines, row("-text")), {
    file: "README.md", hunk: "@@ -1,2 +0,0 @@", line: "-text", newLine: null, oldLine: 2, occurrence: 0,
  });
  for (const text of ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,4 +10,5 @@ function a() {"]) {
    assert.equal(locateDiffLine(lines, row(text)), null, text);
  }
});

test("comments re-anchor by file and exact row when a hunk moves, and go outdated when it disappears", () => {
  const anchor = locateDiffLine(lines, row("+here"));
  assert.equal(commentRowIndex(lines, anchor), row("+here"));
  const moved = lines.map((line) => line === "@@ -40,2 +41,2 @@ function b() {" ? "@@ -60,2 +61,2 @@ function b() {" : line);
  assert.equal(commentRowIndex(moved, { ...anchor, hunk: "@@ -39,2 +40,2 @@ moved" }), row("+here"));
  assert.equal(isCommentOutdated(lines.filter((line) => line !== "+here"), comment(anchor)), true);
  assert.equal(isCommentOutdated(lines, comment(anchor)), false);
});

test("review prompt includes working-copy location, HEAD location and quoted row; control bytes cannot submit", () => {
  const added = locateDiffLine(lines, row("+new three"));
  const removed = locateDiffLine(lines, row("-old two"));
  const prompt = reviewPrompt([
    comment(added, "name this\x1b[201~\rrm -rf /"),
    comment(removed, "why was this removed?"),
  ], "/work/proj");
  assert.match(prompt, /^Review comments on the current working diff in \/work\/proj\./);
  assert.match(prompt, /\n1\. src\/a\.ts:12\n   @@ -10,4 \+10,5 @@ function a\(\) \{\n   > \+new three\n   name this \nrm -rf \/\n/);
  assert.match(prompt, /\n2\. src\/a\.ts:11 \(removed line, numbered in HEAD\)\n/);
  assert.doesNotMatch(prompt, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  assert.equal(reviewPtyPayload(prompt), `\x1b[200~${prompt}\x1b[201~`);
});

test("oversized prompt is refused rather than silently truncated", () => {
  const anchor = locateDiffLine(lines, row("+new three"));
  assert.throws(() => reviewPrompt([comment(anchor, "x".repeat(MAX_DIFF_REVIEW_PROMPT_BYTES))], "/work/proj"), /too long/);
});

test("repository text and checkout paths cannot inject terminal controls into a review prompt", () => {
  const anchor = locateDiffLine(lines, row("+new three"));
  const unsafe = comment({ ...anchor, file: "src/\u001b]52;clipboard\u0007a.ts", hunk: "@@ -1 +1 @@\u001b[?1049h", line: "+row\u001b[201~tail" });
  const prompt = reviewPrompt([unsafe], "/work/project\u001b[2J");
  assert.doesNotMatch(prompt.replace(/\n/g, ""), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  assert.doesNotMatch(prompt, /\[201~/);
  assert.match(prompt, /src\/ \]52;clipboard a\.ts/);
});
