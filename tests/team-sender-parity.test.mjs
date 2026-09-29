// The teams window tells Aya's own messages apart by their sender, and shows
// the tail of the log main returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AYA_SENDER } from "../dist-test/team-view.js";
import { roleIdProblem } from "../dist-test/team-edit.js";
import { RESERVED_ROLE_PROBLEM, TEAM_SYSTEM_SENDER } from "../dist-electron/teams.js";

test("the renderer's name for Aya as a sender is the one the runner logs", () => {
  assert.equal(AYA_SENDER, "aya");
  assert.equal(AYA_SENDER, TEAM_SYSTEM_SENDER);
});


test("the editor refuses a role named aya with the words main refuses it with", () => {
  assert.equal(roleIdProblem(TEAM_SYSTEM_SENDER), RESERVED_ROLE_PROBLEM);
});

test("user is reserved like aya: main's parser, the IPC check and the editor refuse it in the same words", async () => {
  const { parseTeamFile, TEAM_USER_SENDER, reservedRoleProblem } = await import("../dist-electron/teams.js");
  const { USER_SENDER } = await import("../dist-test/team-view.js");
  assert.equal(TEAM_USER_SENDER, "user");
  assert.equal(USER_SENDER, TEAM_USER_SENDER);
  const problem = reservedRoleProblem("user");
  assert.equal(problem, `"user" is reserved for the user's own messages; name the role something else`);
  assert.equal(roleIdProblem("user"), problem);
  assert.throws(() => parseTeamFile("t", "# t\n## Role: user\nMust not: x\n## Role: b\nMust not: y\n"), { message: `team "t": ${problem}` });
  assert.equal(reservedRoleProblem("tester"), null);
});

test("the role status reads the terminal host's not-running hold in main's words", async () => {
  const view = await import("../dist-test/team-view.js");
  const holds = await import("../dist-electron/pane-holds.js");
  assert.equal(view.HOLD_NOT_RUNNING, holds.HOLD_NOT_RUNNING);
});
