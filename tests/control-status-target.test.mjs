// Precedence rules for routing a control-status update to a terminal. The
// regression behind #40: bin/aya sends terminalId + projectSlug + cwd, and the
// slug/cwd match every project sibling, so a single-pass matcher let the
// project's FIRST terminal shadow the exact-id target.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findStatusTarget } from "../dist-test/control-status-target.js";

function termState(id, overrides = {}) {
  return {
    id,
    projectSlug: "demo",
    presetId: "claude",
    name: id,
    cwd: "/tmp/demo",
    status: "running",
    bell: false,
    exitCode: null,
    ...overrides,
  };
}

// Two terminals in the same project, same cwd - the bin/aya scenario.
const twoSiblings = () => ({
  first: termState("first"),
  second: termState("second"),
});

test("exact terminalId wins even when projectSlug and cwd match the first sibling (#40)", () => {
  const entry = findStatusTarget(twoSiblings(), {
    terminalId: "second",
    projectSlug: "demo",
    cwd: "/tmp/demo",
  });
  assert.equal(entry?.[0], "second");
});

test("terminalId alone targets the right terminal", () => {
  const entry = findStatusTarget(twoSiblings(), { terminalId: "second" });
  assert.equal(entry?.[0], "second");
});

test("no terminalId falls back to projectSlug (first match)", () => {
  const entry = findStatusTarget(twoSiblings(), { projectSlug: "demo" });
  assert.equal(entry?.[0], "first");
});

test("no terminalId falls back to cwd", () => {
  const terminals = {
    a: termState("a", { projectSlug: "p1", cwd: "/x" }),
    b: termState("b", { projectSlug: "p2", cwd: "/y" }),
  };
  const entry = findStatusTarget(terminals, { cwd: "/y" });
  assert.equal(entry?.[0], "b");
});

test("unknown terminalId falls back to projectSlug/cwd (sender's tab was closed)", () => {
  const entry = findStatusTarget(twoSiblings(), {
    terminalId: "gone",
    projectSlug: "demo",
  });
  assert.equal(entry?.[0], "first");
});

test("nothing matches -> undefined", () => {
  const entry = findStatusTarget(twoSiblings(), {
    terminalId: "gone",
    projectSlug: "other",
    cwd: "/elsewhere",
  });
  assert.equal(entry, undefined);
});
