import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shouldPreserveTerminalScrollback,
  shouldUseTerminalWebgl,
  stripScrollbackErase,
} from "../dist-test/terminal-rendering.js";

test("renderer selection keeps opencode on WebGL and disables it for gemini", () => {
  assert.equal(shouldUseTerminalWebgl(true, "opencode"), true);
  assert.equal(shouldUseTerminalWebgl(true, "gemini"), false);
  assert.equal(shouldUseTerminalWebgl(false, "opencode"), false);
});

test("only codex preserves xterm scrollback across CSI 3J", () => {
  assert.equal(shouldPreserveTerminalScrollback("codex"), true);
  assert.equal(shouldPreserveTerminalScrollback("opencode"), false);
  assert.equal(shouldPreserveTerminalScrollback("gemini"), false);
});

test("stripScrollbackErase removes CSI 3J variants but keeps visible erase", () => {
  const chunk = "before\x1b[2Jclear-visible\x1b[3Jdrop-scrollback\x1b[?3Jalt-after";
  assert.equal(stripScrollbackErase(chunk), "before\x1b[2Jclear-visibledrop-scrollbackalt-after");
});
