// An unknown verdict is not in `cantReach` (only a measured can't reach is): its "may not reach Aya" is in the
// pane's `note`, which the Apply banner must read too.

import { test } from "node:test";
import assert from "node:assert/strict";

const { launchNoteOf, launchUnsure } = await import("../dist-electron/launch-mode.js");
const { rolePanesSummary } = await import("../dist-test/team-view.js");

const unknown = { command: "env codex", cwd: "/p", mode: { reach: "unknown", why: "Aya cannot read what env runs", todo: "start codex directly" } };
const widened = { command: "codex", cwd: "/p", added: ["-c", "sandbox_workspace_write.network_access=true"], mode: { reach: "reaches" } };
const pane = (role, launch, reached = false) => {
  const note = launchNoteOf(launch, reached);
  return { role, paneId: role, name: role, preset: null, notReached: null, cantReach: null, note, unsure: launchUnsure(null, note) };
};

// [label, panes, banner before Start]
const ROWS = [
  ["an unknown pane that has not called aya", [pane("tester", unknown)], "tester: tester. May not reach Aya: tester; its status below says why. Start the team when you are ready."],
  ["an unknown pane that has called aya (its note is gone)", [pane("tester", unknown, true)], "tester: tester. Start the team when you are ready."],
  ["a pane Aya widened to reach it (a note, but it reaches)", [pane("tester", widened)], "tester: tester. Start the team when you are ready."],
  [
    "an unknown pane beside one that can't reach",
    [pane("tester", unknown), { ...pane("fixer", widened), cantReach: "can't reach Aya: read-only" }],
    "tester: tester, fixer: fixer. Can't reach Aya: fixer; its status below says why. May not reach Aya: tester; its status below says why. Start the team when you are ready.",
  ],
];

for (const [label, panes, banner] of ROWS) {
  test(`Apply banner | ${label}`, () => {
    assert.equal(rolePanesSummary({ panes, leftWithoutPane: [] }, false), banner);
  });
}
