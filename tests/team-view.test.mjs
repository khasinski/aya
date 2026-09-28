// The tab list's view of teams: role and unread per pane, totals per project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { paneRoles, teamPromptKey, unassignedTeams, unreadTotal } from "../dist-test/team-view.js";

const team = (name, assignments, unread, definition = {}) => ({
  name,
  definition,
  error: null,
  repoChanged: false,
  repoDefinition: null,
  paused: false,
  running: true,
  assignments,
  unread,
  log: [],
});

test("each assigned pane gets its team, role and unread count", () => {
  const teams = [team("ux-review", { tester: "p1", implementer: "p2" }, { tester: 0, implementer: 3 })];
  assert.deepEqual(paneRoles(teams), {
    p1: { team: "ux-review", role: "tester", unread: 0 },
    p2: { team: "ux-review", role: "implementer", unread: 3 },
  });
});

test("unread messages add up across a project's teams", () => {
  assert.equal(unreadTotal([team("a", {}, { x: 2, y: 1 }), team("b", {}, { z: 4 })]), 7);
});

test("only valid teams with no pane assigned are offered on project open", () => {
  const teams = [team("new", {}, {}), team("busy", { x: "p1" }, {}), team("broken", {}, {}, null)];
  assert.deepEqual(unassignedTeams(teams).map((t) => t.name), ["new"]);
});


test("a dismissed team prompt is keyed by project slug and team name", () => {
  assert.equal(teamPromptKey("my-app", "review"), "my-app/review");
});
