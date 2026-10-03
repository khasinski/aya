// A CLI with no composer rule is "starting up" until its screen has not changed for SCREEN_SETTLE_MS after the
// spawn (at most SCREEN_SETTLE_MAX_MS): text typed before it is up goes nowhere.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as vt from "../dist-electron/vt-state.js";

const { closeVtPane, openVtPane, paneHold, writeVtPane } = vt;
const SETTLE = vt.SCREEN_SETTLE_MS;
const MAX = vt.SCREEN_SETTLE_MAX_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STARTING = "is still starting up";
const UI = "\x1b[2J\x1b[Hkilo v1.2 - type a task\r\n> ";

// Every lookup by agent falls through to one default for these CLIs, so no agent and one named one stand for them all.
const AGENTS = [undefined, "kilo"];

// [name, steps]: a step is ["draw", text] | ["wait", ms] | ["hold", expected]
const CELLS = [
  ["nothing drawn yet, asked at once: starting", [["hold", STARTING]]],
  // A CLI blank for a cold start (OpenCode measured over 2.5 s; kilo is its fork).
  ["nothing drawn, quiet since the spawn: still starting", [["wait", SETTLE + 150], ["hold", STARTING]]],
  ["nothing drawn for a while, then it draws and settles: starting, then free", [["wait", SETTLE + 150], ["hold", STARTING], ["draw", UI], ["hold", STARTING], ["wait", SETTLE + 150], ["hold", null]]],
  ["drew its screen, asked at once: starting", [["draw", UI], ["hold", STARTING]]],
  ["drew its screen, then quiet: free", [["draw", UI], ["wait", SETTLE + 150], ["hold", null]]],
  ["asked before it drew, then it draws and settles: starting, then free", [["hold", STARTING], ["draw", UI], ["hold", STARTING], ["wait", SETTLE + 150], ["hold", null]]],
  [
    "draws in bursts closer than the settle time: starting until the last burst has settled",
    [["draw", UI], ["wait", SETTLE / 2], ["draw", "loading 1\r\n"], ["wait", SETTLE / 2], ["draw", "loading 2\r\n"], ["hold", STARTING], ["wait", SETTLE + 150], ["hold", null]],
  ],
  ["settled once, then it answers: free, never starting again", [["draw", UI], ["wait", SETTLE + 150], ["hold", null], ["draw", "streaming an answer\r\n"], ["hold", null]]],
  ["a prompt drawn at once is a prompt, not a start", [["draw", "\x1b[2J\x1b[HDo you want to proceed? [y/n]"], ["hold", "shows an approval prompt"]]],
];

// The mirror map is shared, but every case owns a distinct pane id. Keep
// real production-clock waits and run independent screens together.
describe("screen settling with isolated panes", { concurrency: true }, () => {
  for (const agent of AGENTS) {
    for (const [cell, [name, steps]] of CELLS.entries()) {
      test(`${agent ?? "unknown agent"}: ${name}`, async () => {
        const id = `settle-${agent ?? "unknown"}-${cell}`;
        openVtPane(id, 100, 30, () => {}, agent, false);
        try {
          for (const [kind, arg] of steps) {
            if (kind === "draw") writeVtPane(id, arg);
            else if (kind === "wait") await sleep(arg);
            else assert.equal(await paneHold(id), arg);
          }
        } finally {
          closeVtPane(id);
        }
      });
    }
  }

  test("a screen that never stops changing (a ticking clock) is taken as up after SCREEN_SETTLE_MAX_MS", async () => {
    openVtPane("tick", 100, 30, () => {}, "kilo", false);
    const tick = setInterval(() => writeVtPane("tick", `\x1b[H${Date.now()}`), SETTLE / 4);
    try {
      await sleep(SETTLE + 150);
      assert.equal(await paneHold("tick"), STARTING);
      await sleep(MAX - SETTLE);
      assert.equal(await paneHold("tick"), null);
    } finally {
      clearInterval(tick);
      closeVtPane("tick");
    }
  });

  test("a CLI that never draws anything is taken as up after SCREEN_SETTLE_MAX_MS", async () => {
    openVtPane("blank", 100, 30, () => {}, "kilo", false);
    try {
      await sleep(MAX - SETTLE);
      assert.equal(await paneHold("blank"), STARTING);
      await sleep(SETTLE + 150);
      assert.equal(await paneHold("blank"), null);
    } finally {
      closeVtPane("blank");
    }
  });

  test("the settle time is one constant, shorter than a role's wait for its pane to start", async () => {
    const { PANE_START_WAIT_MS } = await import("../dist-electron/team-panes.js");
    assert.ok(vt.SCREEN_SETTLE_MS > 0 && vt.SCREEN_SETTLE_MAX_MS < PANE_START_WAIT_MS);
    assert.deepEqual([vt.SCREEN_SETTLE_MS, vt.SCREEN_SETTLE_MAX_MS], [1_000, 8_000]);
  });

  test("a plain shell is a shell, not starting", async () => {
    openVtPane("sh", 100, 30, () => {}, undefined, true);
    try {
      assert.match(await paneHold("sh"), /shell/);
    } finally {
      closeVtPane("sh");
    }
  });
});
