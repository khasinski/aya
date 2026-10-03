// The rendered screen is the only source of a dialog: a drawn composer under a question in the agent's own
// answer ("Do you want me to ...?") is no edge at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPtyEvent } from "../dist-test/pty-event-reducer.js";

const { closeVtPane, openVtPane, writeVtPane, __testScanVtPane } = await import("../dist-electron/vt-state.js");

const settle = () => new Promise((r) => setTimeout(r, 30));
const RULE = "─".repeat(40);
const COMPOSER = `${RULE}\r\n❯ \r\n${RULE}\r\n  ⏵⏵ auto mode on (shift+tab to cycle)\r\n`;

// [label, agent, screen, reports]  reports: what the callback gets over two scans
// One transcript-wording screen stands for vt-hold-transcript-text's table on the edge layer (scanPane).
const SCREENS = [
  ["a question in the transcript above a drawn composer", "claude", `⏺ Do you want me to start titleCase now?\r\n\r\n${COMPOSER}`, []],
  ["a real approval dialog", "claude", "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n", [true]],
  ["the same question on an agent with the generic rules", undefined, "Do you want me to start now?\r\n\r\n$ ", [true]],
];
for (const [label, agent, screen, reports] of SCREENS) {
  test(`vt report | ${label}`, async () => {
    const seen = [];
    openVtPane("v1", 80, 24, (waiting) => seen.push(waiting), agent);
    try {
      writeVtPane("v1", screen);
      await settle();
      __testScanVtPane("v1");
      __testScanVtPane("v1");
      assert.deepEqual(seen, reports);
    } finally {
      closeVtPane("v1");
    }
  });
}

const term = (overrides) => ({ id: "t1", projectSlug: "demo", presetId: "claude", name: "t1", cwd: "/tmp", status: "running", bell: false, exitCode: null, ...overrides });
const QUESTION = "⏺ Do you want me to start titleCase now?\r\n";

test("reducer | the raw question raises nothing", () => {
  const prev = { t1: term() };
  assert.equal(applyPtyEvent(prev, { type: "data", ptyId: "t1", chunk: QUESTION }), prev);
});

// A clear verdict only ever takes a waiting state back.
const NOT_WAITING = [
  ["idle", { status: "idle", stopped: true }],
  ["done", { status: "done" }],
  ["error", { status: "error" }],
];
for (const [label, overrides] of NOT_WAITING) {
  test(`reducer | a clear verdict leaves a ${label} terminal alone`, () => {
    const prev = { t1: term(overrides) };
    assert.equal(applyPtyEvent(prev, { type: "vt-status", ptyId: "t1", waiting: false }), prev);
  });
}
