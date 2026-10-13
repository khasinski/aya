import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateTerminalLists,
  calculateVisibleTerminalIds,
} from "../dist-test/terminal-visibility.js";
import { layoutRects, leaf, splitLeaf } from "../dist-test/split-tree.js";

const terminal = (id, projectSlug = "active", over = {}) => ({
  id,
  projectSlug,
  presetId: "claude",
  name: id,
  cwd: `/${projectSlug}`,
  status: "running",
  bell: false,
  exitCode: null,
  ...over,
});
const record = (items) => Object.fromEntries(items.map((item) => [item.id, item]));
const project = (slug, ids = []) => ({
  slug,
  name: slug,
  directory: `/${slug}`,
  tabs: ids.map((id) => ({ id })),
});

test("split visibility follows pane order and drops empty or missing terminals", () => {
  const tree = splitLeaf(leaf("left", "second"), "left", "row", "split", "right");
  const panes = [
    ...layoutRects(tree),
    { terminalId: "missing" },
    { terminalId: "" },
    { terminalId: "first" },
    { terminalId: "second" },
  ];
  assert.deepEqual(
    calculateVisibleTerminalIds(tree, panes, "other", record([
      terminal("first"), terminal("second"), terminal("other"),
    ])),
    ["second", "first", "second"],
  );
});

test("single-terminal trees use their pane instead of the active tab", () => {
  const tree = leaf("single", "shown");
  assert.deepEqual(
    calculateVisibleTerminalIds(tree, layoutRects(tree), "active", record([
      terminal("shown", "active", { spawnDeferred: true }), terminal("active"),
    ])),
    ["shown"],
  );
  assert.deepEqual(calculateVisibleTerminalIds(tree, layoutRects(tree), "active", {}), []);
});

test("without a tree visibility uses the active tab without checking the terminal map", () => {
  assert.deepEqual(calculateVisibleTerminalIds(null, [], "missing", {}), ["missing"]);
  assert.deepEqual(calculateVisibleTerminalIds(null, [{ terminalId: "ignored" }], null, {}), []);
  assert.deepEqual(calculateVisibleTerminalIds(null, [], "", {}), []);
});

test("hidden pool includes active-project and warm-project terminals and one per cold project", () => {
  const items = [
    terminal("cold-first", "cold"),
    terminal("warm-other", "warm"),
    terminal("visible"),
    terminal("active-hidden"),
    terminal("cold-selected", "cold"),
    terminal("fallback-first", "fallback"),
    terminal("fallback-other", "fallback"),
    terminal("unmounted", "closed"),
    terminal("warm-deferred", "warm", { spawnDeferred: true }),
    terminal("active-deferred", "active", { spawnDeferred: true }),
    terminal("deferred-first", "deferred", { spawnDeferred: true }),
  ];
  const terminals = record(items);
  const projectTerminals = [terminals["active-hidden"], terminals.visible, terminals["active-deferred"]];
  const result = calculateTerminalLists(
    ["visible"], ["warm"], projectTerminals, terminals,
    [project("cold", ["cold-first", "cold-selected"]),
      project("fallback", ["fallback-first", "fallback-other"]),
      project("deferred", ["deferred-first"]), project("empty")],
    { cold: "cold-selected" },
  );
  assert.deepEqual(result.hiddenTerminals, [
    terminals["warm-other"], terminals["active-hidden"],
    terminals["cold-selected"], terminals["fallback-first"],
  ]);
  assert.deepEqual(result.assignableProjectTerminals, [
    terminals["active-hidden"], terminals["active-deferred"],
  ]);
  assert.strictEqual(result.hiddenTerminals[0], terminals["warm-other"]);
  assert.strictEqual(result.assignableProjectTerminals[1], terminals["active-deferred"]);
  assert.equal(terminals["active-deferred"].spawnDeferred, true);
  assert.deepEqual(projectTerminals.map((t) => t.id), ["active-hidden", "visible", "active-deferred"]);
});

test("warm terminals stay mounted even without a matching open project", () => {
  const warm = terminal("warm", "recent");
  const result = calculateTerminalLists([], ["recent"], [], record([warm]), [], {});
  assert.deepEqual(result, { hiddenTerminals: [warm], assignableProjectTerminals: [] });
});

test("a stale or empty selected tab does not fall back to the project's first tab", () => {
  const first = terminal("first", "cold");
  for (const selected of ["missing", ""]) {
    assert.deepEqual(
      calculateTerminalLists([], [], [], record([first]), [project("cold", ["first"])], { cold: selected }),
      { hiddenTerminals: [], assignableProjectTerminals: [] },
    );
  }
});

test("a null selected tab falls back to the first project tab", () => {
  const first = terminal("first", "cold");
  assert.deepEqual(
    calculateTerminalLists([], [], [], record([first]), [project("cold", ["first"])], { cold: null }),
    { hiddenTerminals: [first], assignableProjectTerminals: [] },
  );
});

test("visible terminals are excluded from both lists even when warm or deferred", () => {
  const shown = terminal("shown", "active", { spawnDeferred: true });
  assert.deepEqual(
    calculateTerminalLists(["shown"], ["active"], [shown], record([shown]), [project("active", ["shown"])], {}),
    { hiddenTerminals: [], assignableProjectTerminals: [] },
  );
  assert.deepEqual(calculateTerminalLists([], [], [], {}, [], {}), {
    hiddenTerminals: [], assignableProjectTerminals: [],
  });
});
