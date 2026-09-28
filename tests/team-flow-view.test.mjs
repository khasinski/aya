// The flow graph drawn from the Sends to checkboxes, before any model runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { flowEdges, flowKey, flowLayout } from "../dist-test/team-flow.js";

const role = (id, sendsTo, responsibilities = "") => ({ id, sendsTo, responsibilities, mustNot: "x" });

test("edges follow the checkboxes: named roles only, no self, once each", () => {
  const roles = [role("a", ["b", "a", "b", "gone"]), role("b", []), role("", ["a"])];
  assert.deepEqual(flowEdges(roles), [{ from: "a", to: "b" }]);
});

test("the key changes with text or ticks, not with the name or the cadence", () => {
  const team = { name: "t", roles: [role("a", ["b"]), role("b", [])], cadence: null, protocol: "p" };
  const key = flowKey(team);
  assert.equal(flowKey({ ...team, name: "other", cadence: { role: "a", minutes: 5 } }), key);
  assert.notEqual(flowKey({ ...team, protocol: "q" }), key);
  assert.notEqual(flowKey({ ...team, roles: [role("a", []), role("b", [])] }), key);
  assert.notEqual(flowKey({ ...team, roles: [role("a", ["b"], "new text"), role("b", [])] }), key);
});

test("nodes sit apart inside the box", () => {
  const at = flowLayout(["a", "b", "c", "d"], 300, 200);
  const points = Object.values(at);
  assert.equal(points.length, 4);
  for (const p of points) assert.ok(p.x > 0 && p.x < 300 && p.y > 0 && p.y < 200, JSON.stringify(p));
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) assert.ok(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) > 60);
});

test("gaps: a role nobody sends to, and a role that sends to nobody", async () => {
  const { flowGaps } = await import("../dist-test/team-flow.js");
  // team1 as saved by hand: the implementer never hears from anyone.
  const roles = [role("reviewer", ["tester"]), role("implementer", ["reviewer"]), role("tester", ["reviewer"]), role("", ["x"])];
  assert.deepEqual(flowGaps(roles), { unreached: ["implementer"], silent: [] });
  assert.deepEqual(flowGaps([role("a", ["b"]), role("b", ["ghost", "b"])]), { unreached: ["a"], silent: ["b"] });
});
