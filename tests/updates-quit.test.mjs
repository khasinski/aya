// A downloaded update replaces the PTY host, and the next launch restarts it, stopping what panes run in the background
// (finding 16), an agent's turn and a shell's command (#217). An ordinary quit must not install it past the background
// work; Restart to update and the launch ask before the restart, and the launch does not ask again what was confirmed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const importHome = mkdtempSync(join(tmpdir(), "aya-updates-import-"));
const savedHome = process.env.HOME;
const savedAyaHome = process.env.AYA_HOME;
process.env.HOME = importHome;
process.env.AYA_HOME = join(importHome, "aya");
const { ordinaryQuitInstalls, restartStaleHost, updateInstaller } = await import("../dist-electron/updates.js");
const { renderPaneText } = await import("../dist-electron/pane-render.js");

test.after(() => {
  rmSync(importHome, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedAyaHome === undefined) delete process.env.AYA_HOME;
  else process.env.AYA_HOME = savedAyaHome;
});

const dir = new URL("./fixtures/own-screens/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("claude-idle.meta.json", dir), "utf8"));
const IDLE = await renderPaneText(readFileSync(new URL("claude-idle.raw", dir), "utf8"), meta.cols, meta.rows);
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
assert.ok(IDLE.endsWith(FOOTER));
const MONITOR = IDLE.replace(FOOTER, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 monitor · ← for agents");

// [update downloaded, a pane shows background work, installs]
const QUITS = [
  [false, false, false],
  [false, true, false],
  [true, false, true],
  [true, true, false],
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
    busy: async () => false,
    foreground: async () => null,
    ...extra,
  };
}

const busyIn = (...ids) => ({ busy: async (id) => ids.includes(id) });

describe("a quit with a downloaded update", () => {
  for (const [downloaded, work, installs] of QUITS) {
    test(`downloaded ${downloaded ? "yes" : "no"} | background work ${work ? "yes" : "no"}: ${installs ? "installs" : "does not install"}`, async () => {
      const deps = relaunch(work ? { "pane-t": MONITOR, "pane-x": IDLE } : { "pane-t": IDLE, "pane-x": IDLE });
      try {
        assert.equal(await ordinaryQuitInstalls(deps, downloaded), installs, "read off the panes' screens");
      } finally {
        rmSync(deps.root, { recursive: true, force: true });
      }
    });
  }

  // A pane runs when the host gives it a process (pid a number) or cannot say (undefined); null: not running.
  // [case, pane-t's screen ("throws" when reading fails), pane-t's pid ("throws" when asking fails), installs]
  const UNREADABLE = [
    ["a running pane whose screen read fails: unknown, no install", "throws", 100, false],
    ["a running pane with no screen: unknown, no install", null, 100, false],
    ["a pane whose process the host cannot name, no screen: unknown, no install", null, undefined, false],
    ["a pane whose process cannot be asked, screen read fails: unknown, no install", "throws", "throws", false],
    ["a pane that is not running, no screen: installs", null, null, true],
    ["a pane that is not running, screen read fails: installs", "throws", null, true],
    ["a running pane read idle: installs", IDLE, 100, true],
  ];
  for (const [name, screen, pid, installs] of UNREADABLE) {
    test(name, async () => {
      const deps = relaunch({}, {
        panes: async () => [{ id: "pane-t", name: "tester" }],
        screen: async () => (screen === "throws" ? Promise.reject(new Error("render failed")) : screen),
        pid: async () => (pid === "throws" ? Promise.reject(new Error("host busy")) : pid),
      });
      try {
        assert.equal(await ordinaryQuitInstalls(deps, true), installs);
      } finally {
        rmSync(deps.root, { recursive: true, force: true });
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

// [case, extra deps, notes left by a confirmed restart, the question (null: none), restarted?]
const LAUNCH_WORK = [
  ["an agent mid-turn: asked, the user keeps the old host", busyIn("pane-t"), null, "Restarting the terminals for Aya's updated terminal host stops what these panes are doing (tester: mid-turn). An agent mid-turn stops before its turn ends.", false],
  ["a turn the user already confirmed for this process (Restart to update): no second question", busyIn("pane-t"), { "pane-t": { pid: 100, work: "mid-turn", at: Date.now(), quiet: true } }, null, true],
  ["a confirmed turn, and another pane now mid-turn: asked about that one only", busyIn("pane-t", "pane-x"), { "pane-t": { pid: 100, work: "mid-turn", at: Date.now(), quiet: true } }, "Restarting the terminals for Aya's updated terminal host stops what these panes are doing (loose: mid-turn). An agent mid-turn stops before its turn ends.", false],
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
        if (asked) assert.match(questions[0], /^Restarting the terminals for Aya's updated terminal host stops what these panes are doing \(tester: 1 monitor\)/);
      } finally {
        rmSync(deps.root, { recursive: true, force: true });
      }
    });
  }

  for (const [name, extra, noted, question, restarted] of LAUNCH_WORK) {
    test(name, async () => {
      const deps = relaunch({ "pane-t": IDLE, "pane-x": IDLE }, extra);
      if (noted) writeFileSync(deps.file, JSON.stringify(noted));
      try {
        const questions = [];
        const did = await restartStaleHost(deps, async (q) => (questions.push(q), false), async () => {});
        assert.deepEqual(questions, question ? [question] : []);
        assert.equal(did, restarted);
      } finally {
        rmSync(deps.root, { recursive: true, force: true });
      }
    });
  }
});

/** The installer as main.ts wires it, with the updater, the dialog and app.quit recorded. */
function installer({ phase = "downloaded", screens = { "pane-t": IDLE, "pane-x": IDLE }, answer = true, installing = false, handoff = null, extra = {} } = {}) {
  const deps = relaunch(screens, extra);
  const seen = { asked: [], installs: [], marks: [], cleared: 0, quits: 0, failed: [] };
  const updater = {
    autoRunAppAfterInstall: true,
    quitAndInstall: (silent, runAfter) => {
      if (handoff) throw new Error(handoff);
      seen.installs.push([silent, runAfter, updater.autoRunAppAfterInstall]);
    },
  };
  const latch = { installing };
  const it = updateInstaller({
    status: () => ({ phase, downloadedVersion: "0.9.0" }),
    relaunch: deps,
    ask: async (text) => (seen.asked.push(text), answer),
    latch,
    mark: async (v) => void seen.marks.push(v),
    markSync: (v) => void seen.marks.push(v),
    clearMark: async () => void seen.cleared++,
    updater,
    quit: () => void seen.quits++,
    failed: (message) => void seen.failed.push(message),
    settleMs: 60_000,
  });
  return { it, seen, latch, deps };
}

// Restart to update (the updates:install IPC handler).
// [case, setup, throws, asked, installed as quitAndInstall(false, true)]
const INSTALLS = [
  ["no downloaded update: refused", { phase: "available" }, true, false, false],
  ["no background work: installs without a question", {}, false, false, true],
  ["a monitor, the user restarts: asked, installs", { screens: { "pane-t": MONITOR, "pane-x": IDLE } }, false, true, true],
  ["a monitor, the user cancels: asked, no install", { screens: { "pane-t": MONITOR, "pane-x": IDLE }, answer: false }, false, true, false],
  ["an install already handed off: no second one, no question", { installing: true, screens: { "pane-t": MONITOR, "pane-x": IDLE } }, false, false, false],
  ["an agent mid-turn, the user restarts: asked, installs", { extra: busyIn("pane-t") }, false, true, true],
  ["an agent mid-turn, the user cancels: asked, no install", { extra: busyIn("pane-t"), answer: false }, false, true, false],
  ["a shell running a command, the user restarts: asked, installs", { extra: { agentOf: async (id) => (id === "pane-x" ? "custom" : "claude"), foreground: async (id) => (id === "pane-x" ? "npm run dev" : null) } }, false, true, true],
];

// What Restart to update asks, by its case above.
const INSTALL_QUESTIONS = {
  "a monitor, the user restarts: asked, installs": /^Restarting to update stops what these panes are doing \(tester: 1 monitor\)/,
  "a monitor, the user cancels: asked, no install": /^Restarting to update stops what these panes are doing \(tester: 1 monitor\)/,
  "an agent mid-turn, the user restarts: asked, installs": /^Restarting to update stops what these panes are doing \(tester: mid-turn\)\. An agent mid-turn stops before its turn ends\.$/,
  "an agent mid-turn, the user cancels: asked, no install": /^Restarting to update stops what these panes are doing \(tester: mid-turn\)/,
  "a shell running a command, the user restarts: asked, installs": /^Restarting to update stops what these panes are doing \(loose: running npm run dev\)\. A command running in a shell stops\.$/,
};

describe("Restart to update", () => {
  for (const [name, setup, throws, asked, installed] of INSTALLS) {
    test(name, async () => {
      const { it, seen, latch, deps } = installer(setup);
      try {
        if (throws) await assert.rejects(it.install(), /No downloaded update/);
        else await it.install();
        assert.equal(seen.asked.length > 0, asked);
        if (asked) assert.match(seen.asked[0], INSTALL_QUESTIONS[name]);
        assert.deepEqual(seen.installs, installed ? [[false, true, true]] : []);
        assert.deepEqual(seen.marks, installed ? ["0.9.0"] : []);
        if (installed) assert.equal(latch.installing, true, "a second click finds the latch");
      } finally {
        rmSync(deps.root, { recursive: true, force: true });
      }
    });
  }

  test("a turn confirmed by Restart to update is not asked about again when the next launch restarts the old host", async () => {
    const { it, seen, deps } = installer({ extra: busyIn("pane-t") });
    try {
      await it.install();
      assert.equal(seen.asked.length, 1);
      assert.equal(JSON.parse(readFileSync(deps.file, "utf8"))["pane-t"].quiet, true);
      // The relaunched app finds the old host; the agent is still mid-turn in the same process.
      let restarts = 0;
      assert.equal(await restartStaleHost(deps, async () => assert.fail("asked twice"), async () => void restarts++), true);
      assert.equal(restarts, 1);
    } finally {
      rmSync(deps.root, { recursive: true, force: true });
    }
  });

  test("a handoff that throws releases the latch, clears the marker and says why", async () => {
    const { it, seen, latch, deps } = installer({ handoff: "ShipIt missing" });
    try {
      await it.install();
      assert.equal(latch.installing, false);
      assert.equal(seen.cleared, 1);
      assert.deepEqual(seen.failed, ["Couldn't start the update: ShipIt missing"]);
    } finally {
      rmSync(deps.root, { recursive: true, force: true });
    }
  });
});

// An ordinary quit (before-quit) with the update state.
// [case, setup, quit held, installed as quitAndInstall(false, false) with no relaunch, app.quit called]
const BEFORE_QUITS = [
  ["no downloaded update: the quit goes on", { phase: "available" }, false, false, 0],
  ["downloaded, no background work: held, installs without relaunch", {}, true, true, 0],
  ["downloaded, a monitor: held, quits without installing", { screens: { "pane-t": MONITOR, "pane-x": IDLE } }, true, false, 1],
  ["downloaded, a running pane unreadable: held, quits without installing", { screens: { "pane-t": IDLE } }, true, false, 1],
  // As before #217: the next launch asks before the restart stops the turn.
  ["downloaded, an agent mid-turn: held, installs without relaunch", { extra: busyIn("pane-t") }, true, true, 0],
  ["an install already handed off: the quit goes on", { installing: true }, false, false, 0],
];

describe("an ordinary quit", () => {
  for (const [name, setup, held, installed, quits] of BEFORE_QUITS) {
    test(name, async () => {
      const { it, seen, deps } = installer(setup);
      try {
        let prevented = 0;
        const done = it.beforeQuit({ preventDefault: () => void prevented++ });
        assert.equal(prevented > 0, held);
        assert.equal(Boolean(done), held);
        await done;
        assert.deepEqual(seen.installs, installed ? [[false, false, false]] : []);
        assert.deepEqual(seen.marks, installed ? ["0.9.0"] : []);
        assert.equal(seen.quits, quits);
        assert.equal(seen.asked.length, 0, "an ordinary quit never asks");
        assert.equal(it.beforeQuit({ preventDefault: () => assert.fail("decided once") }), null, "the next before-quit goes on");
      } finally {
        rmSync(deps.root, { recursive: true, force: true });
      }
    });
  }
});
