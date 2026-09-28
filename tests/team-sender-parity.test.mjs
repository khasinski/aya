// The teams window tells Aya's own messages apart by their sender, and shows
// the tail of the log main returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AYA_SENDER, TEAM_LOG_VISIBLE } from "../dist-test/team-view.js";
import { TEAM_SYSTEM_SENDER } from "../dist-electron/teams.js";
import { LOG_TAIL } from "../dist-electron/team-admin.js";

test("the renderer's name for Aya as a sender is the one the runner logs", () => {
  assert.equal(AYA_SENDER, "aya");
  assert.equal(AYA_SENDER, TEAM_SYSTEM_SENDER);
});

test("the teams window shows the last 8 logged messages, within what main returns", () => {
  assert.equal(TEAM_LOG_VISIBLE, 8);
  assert.ok(TEAM_LOG_VISIBLE <= LOG_TAIL);
});
