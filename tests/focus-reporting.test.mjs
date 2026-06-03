// Focus-reporting (DECSET 1004) tracking — the signal that gates the
// Shift+Enter soft newline (active only while a rich TUI like claude/codex is
// running, never at a plain shell prompt).

import { test } from "node:test";
import assert from "node:assert/strict";
import { focusReportingState } from "../dist-test/focus-reporting.js";

test("enables on ESC[?1004h", () => {
  assert.equal(focusReportingState("\x1b[?1004h", false), true);
});

test("disables on ESC[?1004l", () => {
  assert.equal(focusReportingState("\x1b[?1004l", true), false);
});

test("leaves state unchanged when the chunk has no 1004 transition", () => {
  assert.equal(focusReportingState("hello \x1b[?2004h world", false), false);
  assert.equal(focusReportingState("plain prompt %", true), true);
});

test("does not confuse other DECSET modes (2004, 1049) with 1004", () => {
  assert.equal(focusReportingState("\x1b[?2004h\x1b[?1049h", false), false);
});

test("last transition in a chunk wins", () => {
  assert.equal(focusReportingState("\x1b[?1004h some output \x1b[?1004l", false), false);
  assert.equal(focusReportingState("\x1b[?1004l\x1b[?1004h", true), true);
});

test("ignores a longer mode number that merely starts with 1004 (e.g. ?10049h)", () => {
  // The trailing h/l must come immediately after 1004; a longer param like
  // 10049 is a different mode and must not toggle focus reporting. Pins the
  // (h|l) anchor so loosening the regex to /\x1b\[\?1004/ is caught.
  assert.equal(focusReportingState("\x1b[?10049h", false), false);
  assert.equal(focusReportingState("\x1b[?10049l", true), true);
});

test("recognizes 1004 alongside the modes claude actually emits", () => {
  // From the real capture: claude turns on cursor-hide, paste, focus, theme.
  const chunk = "\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h";
  assert.equal(focusReportingState(chunk, false), true);
});
