// Review comments on the status-bar diff: where a row sits (file, hunk, line
// numbers on both sides), the prompt a pane gets, and finding a comment's row
// again after the diff reloads.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commentRowIndex,
  locateDiffLine,
  reviewPrompt,
} from "../dist-test/diff-review.js";

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

test("locateDiffLine numbers a row on both sides from its hunk header", () => {
  assert.deepEqual(locateDiffLine(lines, row(" keep one")), {
    file: "src/a.ts",
    hunk: "@@ -10,4 +10,5 @@ function a() {",
    line: " keep one",
    newLine: 10,
    oldLine: 10,
  });
  assert.deepEqual(locateDiffLine(lines, row("-old two")), {
    file: "src/a.ts",
    hunk: "@@ -10,4 +10,5 @@ function a() {",
    line: "-old two",
    newLine: null,
    oldLine: 11,
  });
  assert.deepEqual(locateDiffLine(lines, row("+new three")), {
    file: "src/a.ts",
    hunk: "@@ -10,4 +10,5 @@ function a() {",
    line: "+new three",
    newLine: 12,
    oldLine: null,
  });
  assert.deepEqual(locateDiffLine(lines, row(" keep four")), {
    file: "src/a.ts",
    hunk: "@@ -10,4 +10,5 @@ function a() {",
    line: " keep four",
    newLine: 13,
    oldLine: 12,
  });
  // The second hunk counts from its own header, not the first's.
  assert.deepEqual(locateDiffLine(lines, row("+here")), {
    file: "src/a.ts",
    hunk: "@@ -40,2 +41,2 @@ function b() {",
    line: "+here",
    newLine: 42,
    oldLine: null,
  });
});

test("locateDiffLine names a deleted file from its --- line", () => {
  assert.deepEqual(locateDiffLine(lines, row("-text")), {
    file: "README.md",
    hunk: "@@ -1,2 +0,0 @@",
    line: "-text",
    newLine: null,
    oldLine: 2,
  });
});

test("locateDiffLine refuses rows that are not code", () => {
  for (const text of ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,4 +10,5 @@ function a() {"]) {
    assert.equal(locateDiffLine(lines, row(text)), null, text);
  }
  assert.equal(locateDiffLine(lines, 999), null);
});

test("reviewPrompt numbers the comments with their place, the quoted line and the note", () => {
  const prompt = reviewPrompt(
    [
      { ...locateDiffLine(lines, row("+new three")), note: "name this\x1b[201~\rrm -rf /" },
      { ...locateDiffLine(lines, row("-old two")), note: "why was this removed?" },
    ],
    "/Users/dev/proj",
  );
  assert.match(prompt, /^Review comments on the current `git diff` of `\/Users\/dev\/proj`\./);
  assert.match(prompt, /\n1\. src\/a\.ts:12\n   @@ -10,4 \+10,5 @@ function a\(\) \{\n   > \+new three\n   name this  rm -rf \/\n/);
  assert.match(prompt, /\n2\. src\/a\.ts:11 \(removed line, numbered in HEAD\)\n/);
  assert.doesNotMatch(prompt, /[\x00-\x08\x0b-\x1f\x7f]/);
});

test("commentRowIndex finds a comment's row again, in its file and hunk only", () => {
  const keepForty = locateDiffLine(lines, row(" keep forty"));
  assert.equal(commentRowIndex(lines, keepForty), row(" keep forty"));
  // The same text in another hunk is another line.
  assert.equal(commentRowIndex(lines, { ...keepForty, hunk: "@@ -10,4 +10,5 @@ function a() {" }), -1);
  assert.equal(commentRowIndex(lines, locateDiffLine(lines, row("-text"))), row("-text"));
  // Gone from the diff: the comment has nothing to sit under.
  assert.equal(commentRowIndex(lines.filter((l) => l !== "+here"), locateDiffLine(lines, row("+here"))), -1);
});
