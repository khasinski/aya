// A downloaded update replaces the PTY host, and the next launch restarts it, stopping what panes run in the background
// (finding 16). An ordinary quit must not install it past the background work; the launch asks before the restart.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { quitInstalls, ordinaryQuitInstalls, restartStaleHost } = await import("../dist-electron/update-quit.js");
const { renderPaneText } = await import("../dist-electron/pane-render.js");

const dir = new URL("./fixtures/own-screens/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("claude-idle.meta.json", dir), "utf8"));
const IDLE = await renderPaneText(readFileSync(new URL("claude-idle.raw", dir), "utf8"), meta.cols, meta.rows);
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
assert.ok(IDLE.endsWith(FOOTER));
const MONITOR = IDLE.replace(FOOTER, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 monitor · ← for agents");

// [update downloaded, a pane shows background work, explicit (confirmed) update or ordinary quit, installs]
const QUITS = [
  [false, false, "ordinary", false],
  [false, true, "ordinary", false],
  [true, false, "ordinary", true],
  [true, true, "ordinary", false],
  [false, false, "explicit", false],
  [false, true, "explicit", false],
  [true, false, "explicit", true],
  [true, true, "explicit", true],
];

function relaunch(screens, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "aya-update-quit-"));
  return {
    root,
    file: join(root, "relaunch-notes.json"),
    panes: async () => [{ id: "pane-t", name: "tester" }, { id: "pane-x", name: "loose" }],
    agentOf: async () => "claude",
    screen: async (id) => screens[id] ?? null,
    pid: async (id) => ({ "pane-t": 100, "pane-x": 300 })[id],
    command: async () => null,
    ...extra,
  };
}

describe("a quit with a downloaded update", () => {
  for (const [downloaded, work, how, installs] of QUITS) {
    test(`downloaded ${downloaded ? "yes" : "no"} | background work ${work ? "yes" : "no"} | ${how} quit: ${installs ? "installs" : "does not install"}`, async () => {
      assert.equal(quitInstalls({ downloaded, backgroundWork: work, explicit: how === "explicit" }), installs);
      if (how === "ordinary") {
        const deps = relaunch(work ? { "pane-t": MONITOR, "pane-x": IDLE } : { "pane-t": IDLE });
        try {
          assert.equal(await ordinaryQuitInstalls(deps, downloaded), installs, "read off the panes' screens");
        } finally {
          rmSync(deps.root, { recursive: true, force: true });
        }
      }
    });
  }

  test("panes that cannot be read count as background work: no install", async () => {
    const deps = relaunch({}, { panes: async () => Promise.reject(new Error("host gone")) });
    try {
      assert.equal(await ordinaryQuitInstalls(deps, true), false);
    } finally {
      rmSync(deps.root, { recursive: true, force: true });
    }
  });
});

// [case, screens, notes left by a confirmed restart, the user's answer, asked?, restarted?]
const LAUNCHES = [
  ["no background work: restarted without a question", { "pane-t": IDLE }, null, false, false, true],
  ["a monitor: asked, the user restarts", { "pane-t": MONITOR }, null, true, true, true],
  ["a monitor: asked, the user keeps the old host", { "pane-t": MONITOR }, null, false, true, false],
  ["a monitor the user already confirmed for this process (Restart to update): no second question", { "pane-t": MONITOR }, { "pane-t": { pid: 100, work: "1 monitor", at: Date.now() } }, false, false, true],
  ["the old host's panes cannot be read: restarted as before", "unreadable", null, false, false, true],
  ["a note from an earlier process does not confirm this one", { "pane-t": MONITOR }, { "pane-t": { pid: 99, work: "1 monitor", at: Date.now() } }, false, true, false],
];

describe("the next launch finds the old host", () => {
  for (const [name, screens, noted, answer, asked, restarted] of LAUNCHES) {
    test(name, async () => {
      const deps = screens === "unreadable" ? relaunch({}, { panes: async () => Promise.reject(new Error("old host")) }) : relaunch(screens);
      if (noted) writeFileSync(deps.file, JSON.stringify(noted));
      try {
        const questions = [];
        let restarts = 0;
        const did = await restartStaleHost(deps, async (q) => (questions.push(q), answer), async () => void restarts++);
        assert.equal(questions.length > 0, asked);
        assert.equal(did, restarted);
        assert.equal(restarts, restarted ? 1 : 0);
        if (asked) assert.match(questions[0], /^Restarting the terminals for the new Aya version stops what these panes run in the background \(tester: 1 monitor\)/);
      } finally {
        rmSync(deps.root, { recursive: true, force: true });
      }
    });
  }
});
