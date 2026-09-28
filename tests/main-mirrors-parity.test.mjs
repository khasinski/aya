// The renderer's copies of main-process constants (src/main-mirrors.ts) stay
// equal to the electron values they mirror.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as mirrors from "../dist-test/main-mirrors.js";
import * as localSummary from "../dist-electron/local-summary-errors.js";
import * as validation from "../dist-electron/validation.js";
import * as teams from "../dist-electron/teams.js";
import * as usageHook from "../dist-electron/usage-hook.js";

test("the renderer summarizes the same number of trailing lines as main", () => {
  assert.equal(mirrors.LOCAL_SUMMARY_MAX_LINES, 30);
  assert.equal(mirrors.LOCAL_SUMMARY_MAX_LINES, localSummary.LOCAL_SUMMARY_MAX_LINES);
});

test("the renderer writes the project-state version main validates", () => {
  assert.equal(mirrors.PROJECT_STATE_VERSION, 1);
  assert.equal(mirrors.PROJECT_STATE_VERSION, validation.PROJECT_STATE_VERSION);
});

test("the renderer's cadence ceiling is the one main's team parser enforces", () => {
  assert.equal(mirrors.MAX_CADENCE_MINUTES, 24 * 60);
  assert.equal(mirrors.MAX_CADENCE_MINUTES, teams.MAX_CADENCE_MINUTES);
});

test("the usage-chip dialog's throttle is the generated hook script's", () => {
  assert.equal(mirrors.HOOK_THROTTLE_MINUTES, 5);
  assert.equal(mirrors.HOOK_THROTTLE_MINUTES * 60, usageHook.HOOK_THROTTLE_SECONDS);
});
