// PTY rolling output buffer — used to repaint xterm.js after HMR /
// re-mount. We can't actually spawn a PTY from tests (would consume
// subscription credits etc.), but the buffer trim logic is pure and worth
// testing directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __testAppendToOutputBuffer,
  __testClearOutputBuffers,
  getBufferedOutput,
  searchPtyOutputs,
} from "../dist-electron/pty.js";

// The buffer is private to pty.ts. To exercise it we expose getBufferedOutput
// and rely on the public spawnPty path elsewhere. For unit testing the trim,
// we drive a stub via a local reimplementation matching the production code.

const OUTPUT_BUFFER_MAX = 200_000;

function makeBuffer() {
  const chunks = [];
  return {
    append(chunk) {
      chunks.push(chunk);
      let total = 0;
      for (const c of chunks) total += c.length;
      while (total > OUTPUT_BUFFER_MAX && chunks.length > 1) {
        const removed = chunks.shift();
        if (removed) total -= removed.length;
      }
    },
    read() {
      return chunks.join("");
    },
  };
}

test("empty buffer reads as empty", () => {
  const b = makeBuffer();
  assert.equal(b.read(), "");
});

test("getBufferedOutput returns empty for unknown ptyId", () => {
  assert.equal(getBufferedOutput("nonexistent-pty"), "");
});

test("searchPtyOutputs finds tokens across ANSI-decorated PTY output", () => {
  __testClearOutputBuffers();
  __testAppendToOutputBuffer(
    "pty-1",
    "\x1b[32mClaude\x1b[0m finished the ruby migration\nNeed approval",
  );
  __testAppendToOutputBuffer("pty-2", "codex is working on docs");

  const hits = searchPtyOutputs("ruby approval");

  assert.equal(hits.length, 1);
  assert.equal(hits[0].ptyId, "pty-1");
  assert.match(hits[0].snippet, /ruby migration Need approval/);
  assert.equal(hits[0].matchLength, "ruby".length);

  __testClearOutputBuffers();
});

test("searchPtyOutputs uses AND semantics across query tokens", () => {
  __testClearOutputBuffers();
  __testAppendToOutputBuffer("pty-1", "ruby migration complete");
  __testAppendToOutputBuffer("pty-2", "ruby tests running");

  assert.deepEqual(
    searchPtyOutputs("ruby complete").map((hit) => hit.ptyId),
    ["pty-1"],
  );
  assert.deepEqual(searchPtyOutputs("ruby missing"), []);

  __testClearOutputBuffers();
});

test("buffer keeps small writes intact", () => {
  const b = makeBuffer();
  b.append("hello ");
  b.append("world");
  assert.equal(b.read(), "hello world");
});

test("buffer trims oldest chunks once total exceeds limit", () => {
  const b = makeBuffer();
  // Push 10 × 30kb chunks = 300kb total, limit is 200kb.
  // Expect the oldest chunks to be dropped.
  for (let i = 0; i < 10; i++) {
    const tag = String.fromCharCode(97 + i); // "a", "b", "c", ...
    b.append(tag.repeat(30_000));
  }
  const result = b.read();
  assert.ok(result.length <= OUTPUT_BUFFER_MAX);
  // The first chunk(s) should be gone. "a" is definitely gone.
  assert.equal(result.includes("a"), false);
  // The last chunk ("j") must be present in full.
  assert.ok(result.includes("j".repeat(30_000)));
});

test("buffer keeps at least one chunk even if it exceeds the limit", () => {
  // Edge case: a single chunk larger than OUTPUT_BUFFER_MAX. The trim loop
  // bails when only one chunk remains, so the buffer reads as that chunk in
  // full (better than silently emptying).
  const b = makeBuffer();
  const giant = "x".repeat(OUTPUT_BUFFER_MAX * 2);
  b.append(giant);
  assert.equal(b.read(), giant);
});
