// Approval-prompt heuristic. The README sells "notifications when Claude or
// Codex is waiting for your approval" — the bell module is what powers it.
// These patterns drift as agent TUIs evolve; the tests pin them against
// representative samples (real captures + minimal fixtures).

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectApproval, looksBusy } from "../dist-test/bell.js";

test("detects 'Do you want to ...' Claude approval prompts", () => {
  assert.equal(detectApproval("Do you want to make this edit to file.ts?"), true);
  assert.equal(detectApproval("Do you want me to run the tests?"), true);
});

test("detects Claude's numeric approval menu (1. Yes / 2. ...)", () => {
  assert.equal(detectApproval("\n  ❯ 1. Yes\n    2. No, tell Claude what to do differently\n"), true);
  assert.equal(detectApproval("1) Yes, and don't ask again this session"), true);
});

test("detects Codex-style 'Approve ...' prompts", () => {
  assert.equal(detectApproval("Approve this edit?"), true);
  assert.equal(detectApproval("Approve change to package.json?"), true);
  assert.equal(detectApproval("Approve tool call 'shell.exec'"), true);
});

test("detects 'Accept all ... Reject all' two-choice prompts", () => {
  assert.equal(detectApproval("[Accept all]    [Reject all]"), true);
});

test("detects 'Run this command? [Y/N]' shell prompts", () => {
  assert.equal(detectApproval("Run this command? [Y/N]"), true);
});

test("detects approval even when ANSI escape codes wrap the prompt", () => {
  // Claude's TUI repaints with cursor moves + color codes around the actual
  // text. The heuristic strips those before regex matching.
  const ansiWrapped =
    "\x1b[1;34m\x1b[2J\x1b[H  ❯ 1. Yes\x1b[0m\n\x1b[90m    2. No\x1b[0m";
  assert.equal(detectApproval(ansiWrapped), true);
});

test("detects approval across an OSC title-set sequence", () => {
  // OSC ]0;...\x07 sets the window title; the stripper handles that family.
  const withOsc =
    "\x1b]0;claude\x07Do you want to apply this patch?\n";
  assert.equal(detectApproval(withOsc), true);
});

test("does not false-positive on ordinary agent narration", () => {
  assert.equal(detectApproval("Running tests..."), false);
  assert.equal(detectApproval("Done. The build passed in 4.2s."), false);
  assert.equal(detectApproval("I'll edit src/bell.ts next."), false);
});

test("does not false-positive on git / shell output that mentions 'yes'", () => {
  assert.equal(
    detectApproval("On branch main\nYour branch is up to date with 'origin/main'."),
    false,
  );
  assert.equal(detectApproval("Yes, this commit was already pushed."), false);
});

test("does not false-positive on empty or whitespace-only chunks", () => {
  assert.equal(detectApproval(""), false);
  assert.equal(detectApproval("   \n\t  "), false);
});

test("approval patterns are case-insensitive (resilient to agent capitalization changes)", () => {
  assert.equal(detectApproval("DO YOU WANT TO continue?"), true);
  assert.equal(detectApproval("do you want me to retry?"), true);
});

test("looksBusy returns true for substantial output (likely agent working)", () => {
  const longChunk = "Compiling module: ".repeat(10);
  assert.equal(looksBusy(longChunk), true);
});

test("looksBusy returns false for short output (likely a prompt cursor or quiet repaint)", () => {
  assert.equal(looksBusy("$ "), false);
  assert.equal(looksBusy("\n"), false);
  assert.equal(looksBusy(""), false);
});

test("looksBusy pins the length boundary (just-under is quiet, at/over is busy)", () => {
  // The heuristic clears once a chunk's stripped length crosses the threshold.
  const justUnder = "x".repeat(64);
  const over = "x".repeat(65);
  assert.equal(looksBusy(justUnder), false);
  assert.equal(looksBusy(over), true);
});

test("looksBusy ignores ANSI noise when judging length", () => {
  // 100+ chars of ANSI but only a tiny stripped body.
  const ansiHeavy = "\x1b[1;31m\x1b[2J\x1b[H\x1b[0m\x1b[1;34m\x1b[K\x1b[0m" +
    "\x1b]0;title\x07" +
    "hi";
  assert.equal(looksBusy(ansiHeavy), false);
});
