// Context added to a Conversation GUI draft: review comments and terminal output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewCommentsBlock, terminalExcerptBlock, withContextBlock } from "../dist-test/gui-context.js";
import { reviewPrompt } from "../dist-electron/diff-comments-prompt.js";

const comment = (over = {}) => ({ id: "c1", file: "src/a.ts", hunk: "@@ -1,2 +1,3 @@", line: "+const x = 1;", newLine: 3, oldLine: null, occurrence: 1, checkout: "/repo", note: "Why a constant?", createdAt: "", sentAt: null, sentTo: null, ...over });

test("review comments read exactly like the message sent to a terminal pane", () => {
  const list = [comment(), comment({ id: "c2", file: "src/b.ts", newLine: null, oldLine: 9, line: "-old", note: "Keep this\nline two" })];
  assert.equal(reviewCommentsBlock(list, "/repo"), reviewPrompt(list, "/repo"));
  const hostile = [comment({ note: "x\x1b[201~y\x07z", file: "a\nb.ts" })];
  assert.equal(reviewCommentsBlock(hostile, "/repo\n"), reviewPrompt(hostile, "/repo\n"));
});

test("too many comments are refused, never shortened", () => {
  const big = Array.from({ length: 60 }, (_, i) => comment({ id: `c${i}`, note: "n".repeat(1000) }));
  assert.throws(() => reviewCommentsBlock(big, "/repo"), /too long/);
});

test("terminal output becomes a fenced block that its own backticks cannot close", () => {
  assert.equal(terminalExcerptBlock("shell 1", "$ ls\nfile\n\n"), 'Output of the terminal "shell 1":\n```\n$ ls\nfile\n```');
  const tricky = terminalExcerptBlock("t", "a\n```\nb");
  assert.match(tricky, /^Output of the terminal "t":\n````\na\n```\nb\n````$/);
  assert.match(terminalExcerptBlock("t", "ok\x1b[31m red"), /ok \[31m red/, "escape bytes are neutralised");
});

test("a block goes on its own paragraph after the draft", () => {
  assert.equal(withContextBlock("", "BLOCK"), "BLOCK\n\n");
  assert.equal(withContextBlock("please fix  \n", "BLOCK"), "please fix\n\nBLOCK\n\n");
});
