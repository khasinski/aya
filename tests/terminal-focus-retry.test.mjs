import { strict as assert } from "node:assert";
import { test } from "node:test";
import { terminalFocusRetryStillOwned } from "../dist-test/terminal-focus-retry.js";

test("terminal focus retry stays eligible while focus remains on body or another pane", () => {
  const body = {};
  const otherPane = {};
  assert.equal(terminalFocusRetryStillOwned(body, body), true);
  assert.equal(terminalFocusRetryStillOwned(otherPane, otherPane), true);
});

test("terminal focus retry yields after focus moves to a control", () => {
  const pane = {};
  const control = {};
  assert.equal(terminalFocusRetryStillOwned(pane, control), false);
});
