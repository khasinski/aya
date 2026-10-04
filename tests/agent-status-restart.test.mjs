// An agent's `aya status waiting` outlives a quit: the main process keeps the questions under AYA_HOME
// and the window asks for them on boot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "aya-status-home-"));
process.env.AYA_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const modulePath = require.resolve("../dist-electron/agent-status.js");
/** A fresh copy of the module, as after a restart: only the disk is shared (the build is CommonJS, so the cache is cleared). */
const boot = () => {
  delete require.cache[modulePath];
  return require(modulePath);
};

// The screen shows no CLI dialog: the Enter is for the agent.
const FREE = async () => null;

// [label, what the first life did, what the second life should see]
const ROWS = [
  ["waiting survives a restart", (s) => s.recordAgentStatus("lead", "waiting", 1000, "need the staging password"), { lead: { text: "need the staging password", since: 1000 } }],
  ["two panes", (s) => (s.recordAgentStatus("lead", "waiting", 1000, "a"), s.recordAgentStatus("impl", "waiting", 2000, "b")), { lead: { text: "a", since: 1000 }, impl: { text: "b", since: 2000 } }],
  ["waiting then clear", (s) => (s.recordAgentStatus("lead", "waiting", 1000, "a"), s.recordAgentStatus("lead", "clear", 1500)), {}],
  ["waiting then done", (s) => (s.recordAgentStatus("lead", "waiting", 1000, "a"), s.recordAgentStatus("lead", "done", 1500, "finished")), {}],
  ["waiting then the user's Enter", async (s) => (s.recordAgentStatus("lead", "waiting", 1000, "a"), await s.noteUserAnswer("lead", "\r", FREE, 1500)), {}],
  ["one answered, one outstanding", async (s) => (s.recordAgentStatus("lead", "waiting", 1000, "a"), s.recordAgentStatus("impl", "waiting", 1100, "b"), await s.noteUserAnswer("lead", "\r", FREE, 1500)), { impl: { text: "b", since: 1100 } }],
  ["active is not a question", (s) => s.recordAgentStatus("lead", "active", 1000, "working"), {}],
  ["waiting without text keeps an empty text", (s) => s.recordAgentStatus("lead", "waiting", 1000), { lead: { text: "", since: 1000 } }],
  ["a hook's Notification is no question", (s) => s.recordAgentStatus("lead", "waiting", 1000, "Waiting for your next prompt", "hook"), {}],
  ["a question, then the hooks of its turn", (s) => (s.recordAgentStatus("lead", "waiting", 1000, "a"), s.recordAgentStatus("lead", "active", 1100, "running Bash", "hook"), s.recordAgentStatus("lead", "done", 1200, "Turn finished", "hook")), { lead: { text: "a", since: 1000 } }],
];
for (const [label, act, want] of ROWS) {
  test(`restart | ${label}`, async () => {
    const first = await boot();
    first.__resetAgentStatusForTests?.();
    await act(first);
    const second = await boot();
    // Read back from disk, a question is marked as asked before the restart (the window says so).
    const marked = Object.fromEntries(Object.entries(want).map(([pane, q]) => [pane, { ...q, restart: "restored" }]));
    assert.deepEqual(second.outstandingWaiting(), marked);
    for (const pane of Object.keys(want)) assert.equal(second.agentWaitingSince(pane), want[pane].since, "the runner sees it too");
    first.__resetAgentStatusForTests?.();
  });
}

test("restart | a damaged file reads as nothing outstanding", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "agent-waiting.json"), "{not json");
  const s = await boot();
  assert.deepEqual(s.outstandingWaiting(), {});
  s.recordAgentStatus("lead", "waiting", 1, "a");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "agent-waiting.json"), "utf8")), { lead: { text: "a", since: 1, by: "agent" } });
});

test("restart | nothing waiting leaves no file lying about", async () => {
  const s = await boot();
  s.__resetAgentStatusForTests?.();
  s.recordAgentStatus("lead", "waiting", 1, "a");
  s.recordAgentStatus("lead", "clear", 2);
  assert.equal(existsSync(join(home, "agent-waiting.json")), false);
});

test("restart | a file from before hooks were told apart holds no question: its entries may be a hook's idle composer", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "agent-waiting.json"), JSON.stringify({ lead: { text: "Waiting for your next prompt", since: 1 } }));
  const s = await boot();
  assert.deepEqual(s.outstandingWaiting(), {});
  assert.equal(s.agentWaitingSince("lead"), null);
});
