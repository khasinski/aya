// The renderer's copies of main-process constants (src/main-mirrors.ts) stay
// equal to the electron values they mirror.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as mirrors from "../dist-test/main-mirrors.js";
import * as localSummary from "../dist-electron/local-summary-errors.js";
import * as validation from "../dist-electron/validation.js";

test("the renderer summarizes the same number of trailing lines as main", () => {
  assert.equal(mirrors.LOCAL_SUMMARY_MAX_LINES, 30);
  assert.equal(mirrors.LOCAL_SUMMARY_MAX_LINES, localSummary.LOCAL_SUMMARY_MAX_LINES);
});

test("the renderer writes the project-state version main validates", () => {
  assert.equal(mirrors.PROJECT_STATE_VERSION, 1);
  assert.equal(mirrors.PROJECT_STATE_VERSION, validation.PROJECT_STATE_VERSION);
});
