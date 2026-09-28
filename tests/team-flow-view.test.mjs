// The flow graph drawn from the Sends to boxes and their whats; no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { flowEdges, flowGaps, flowLayout } from "../dist-test/team-flow.js";

const role = (id, sends) => ({ id, sendsTo: sends.map(([to, what = ""]) => ({ to, what })), responsibilities: "", mustNot: "x" });

test("edges follow the boxes with their whats: named roles only, no self, once each", () => {
  const roles = [role("a", [["b", " findings "], ["a"], ["b", "again"], ["gone"]]), role("b", []), role("", [["a"]])];
  assert.deepEqual(flowEdges(roles), [{ from: "a", to: "b", what: "findings" }]);
});

test("nodes sit apart inside the box", () => {
  const at = flowLayout(["a", "b", "c", "d"], 300, 200);
  const points = Object.values(at);
  assert.equal(points.length, 4);
  for (const p of points) assert.ok(p.x > 0 && p.x < 300 && p.y > 0 && p.y < 200, JSON.stringify(p));
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) assert.ok(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) > 60);
});

test("gaps: nobody sends to a role, a role sends to nobody, a route says nothing", () => {
  // team1 as saved by hand: the implementer never hears from anyone.
  const team1 = [role("reviewer", [["tester", "fixes"]]), role("implementer", [["reviewer", "changes"]]), role("tester", [["reviewer"]]), role("", [["x"]])];
  assert.deepEqual(flowGaps(team1), {
    unreached: ["implementer"],
    silent: [],
    unsaid: [{ from: "tester", to: "reviewer", what: "" }],
  });
  assert.deepEqual(flowGaps([role("a", [["b", "x"]]), role("b", [["ghost", "y"], ["b", "z"]])]), { unreached: ["a"], silent: ["b"], unsaid: [] });
});
