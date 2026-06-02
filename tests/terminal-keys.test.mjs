// Enter-key decision: restart (Shift+Enter on exited) / soft-newline
// (Shift|Option+Enter in a rich TUI) / submit (Shift|Option+Enter at the shell)
// / default (everything else). The bytes are written by TerminalView; this pins
// the decision that drives them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { enterKeyAction, META_ENTER } from "../dist-test/terminal-keys.js";

const base = {
  shift: false,
  meta: false,
  ctrl: false,
  alt: false,
  canRestart: false,
  richInput: false,
};
const ev = (over) => enterKeyAction({ ...base, ...over });

test("plain Enter is left to xterm (default)", () => {
  assert.equal(ev({}), "default");
});

test("Cmd/Ctrl+Enter are left to xterm", () => {
  assert.equal(ev({ shift: true, meta: true }), "default");
  assert.equal(ev({ shift: true, ctrl: true }), "default");
});

test("bare Shift+Enter on an exited terminal restarts it", () => {
  assert.equal(ev({ shift: true, canRestart: true }), "restart");
});

test("restart wins over soft-newline when both could apply", () => {
  assert.equal(ev({ shift: true, canRestart: true, richInput: true }), "restart");
});

test("Shift+Enter in a rich TUI is a soft newline", () => {
  assert.equal(ev({ shift: true, richInput: true }), "soft-newline");
});

test("Shift+Enter at a plain shell submits", () => {
  assert.equal(ev({ shift: true, richInput: false }), "submit");
});

test("Option+Enter mirrors Shift+Enter (soft newline in TUI, submit at shell)", () => {
  assert.equal(ev({ alt: true, richInput: true }), "soft-newline");
  assert.equal(ev({ alt: true, richInput: false }), "submit");
});

test("Option+Enter does NOT restart (restart is Shift-only)", () => {
  assert.equal(ev({ alt: true, canRestart: true }), "submit");
});

test("Shift+Option+Enter is not a restart (Option present), falls to TUI/shell rule", () => {
  assert.equal(ev({ shift: true, alt: true, canRestart: true, richInput: true }), "soft-newline");
});

test("META_ENTER is ESC + CR", () => {
  assert.equal(META_ENTER, "\x1b\r");
});
