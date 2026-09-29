// The teams window tells Aya's own messages apart by their sender, and shows
// the tail of the log main returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AYA_SENDER, TEAM_LOG_VISIBLE } from "../dist-test/team-view.js";
import { roleIdProblem } from "../dist-test/team-edit.js";
import { RESERVED_ROLE_PROBLEM, TEAM_SYSTEM_SENDER } from "../dist-electron/teams.js";
import { LOG_TAIL } from "../dist-electron/team-admin.js";

test("the renderer's name for Aya as a sender is the one the runner logs", () => {
  assert.equal(AYA_SENDER, "aya");
  assert.equal(AYA_SENDER, TEAM_SYSTEM_SENDER);
});

test("the teams window shows the last 8 logged messages, within what main returns", () => {
  assert.equal(TEAM_LOG_VISIBLE, 8);
  assert.ok(TEAM_LOG_VISIBLE <= LOG_TAIL);
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
