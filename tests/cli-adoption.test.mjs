// Reducers are pure; the store is checked against a real file, including
// updates racing the first load (#117).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLI_ADOPTION_MAX_PANES,
  createCliAdoptionStore,
  emptyCliAdoption,
  normalizeCliAdoption,
  recordCall,
  recordLaunch,
  summarizeCliAdoption,
} from "../dist-electron/cli-adoption.js";

test("launched panes count per harness; only callers count as adopting", () => {
  let s = emptyCliAdoption();
  s = recordLaunch(s, { terminalId: "a", agent: "claude" }, 1);
  s = recordLaunch(s, { terminalId: "b", agent: "claude" }, 2);
  s = recordLaunch(s, { terminalId: "c", agent: "codex" }, 3);
  s = recordCall(s, { terminalId: "a", command: "status" }, 4);
  s = recordCall(s, { terminalId: "a", command: "capabilities" }, 5);
  s = recordCall(s, { terminalId: "c", command: "capabilities" }, 6);
  assert.deepEqual(summarizeCliAdoption(s), [
    { agent: "claude", panesLaunched: 2, panesThatCalledAya: 1, panesThatRanCapabilities: 1 },
    { agent: "codex", panesLaunched: 1, panesThatCalledAya: 1, panesThatRanCapabilities: 1 },
  ]);
});

test("repeat sightings change nothing, so the file is not rewritten", () => {
  let s = recordLaunch(emptyCliAdoption(), { terminalId: "a", agent: "claude" }, 1);
  assert.equal(recordLaunch(s, { terminalId: "a", agent: "claude" }, 2), null);
  s = recordCall(s, { terminalId: "a", command: "status" }, 3);
  assert.equal(recordCall(s, { terminalId: "a", command: "status" }, 4), null);
  s = recordCall(s, { terminalId: "a", command: "capabilities" }, 5);
  assert.equal(s.panes.a.firstCallAt, 3);
});

test("first sightings stick: launch time, and a launch's presetId over a call's", () => {
  let s = recordLaunch(emptyCliAdoption(), { terminalId: "a", agent: "claude", presetId: "p1" }, 1);
  s = recordLaunch(s, { terminalId: "a", agent: "codex" }, 2);
  s = recordCall(s, { terminalId: "a", presetId: "p2", command: "status" }, 3);
  assert.deepEqual(s.panes.a, {
    agent: "codex", presetId: "p1", launchedAt: 1, firstCallAt: 3, commands: ["status"],
  });
});

test("a pane that called before its launch was recorded still counts as launched", () => {
  let s = recordCall(emptyCliAdoption(), { terminalId: "x", command: "status" }, 1);
  s = recordLaunch(s, { terminalId: "x" }, 2);
  assert.equal(s.panes.x.launchedAt, 2);
});

test("harnesses are listed by panes launched, most first", () => {
  let s = recordLaunch(emptyCliAdoption(), { terminalId: "a", agent: "amp" }, 1);
  s = recordLaunch(s, { terminalId: "b", agent: "zed" }, 2);
  s = recordLaunch(s, { terminalId: "c", agent: "zed" }, 3);
  assert.deepEqual(summarizeCliAdoption(s).map((row) => row.agent), ["zed", "amp"]);
});

test("a caller Aya never saw launch is counted under unknown", () => {
  const s = recordCall(emptyCliAdoption(), { terminalId: "x", command: "status" }, 1);
  assert.deepEqual(summarizeCliAdoption(s), [
    { agent: "unknown", panesLaunched: 0, panesThatCalledAya: 1, panesThatRanCapabilities: 0 },
  ]);
});

test("past the cap the oldest panes are dropped", () => {
  let s = emptyCliAdoption();
  for (let i = 0; i <= CLI_ADOPTION_MAX_PANES; i += 1) {
    s = recordLaunch(s, { terminalId: `t${i}`, agent: "claude" }, i);
  }
  assert.equal(Object.keys(s.panes).length, CLI_ADOPTION_MAX_PANES);
  assert.equal(s.panes.t0, undefined);
  assert.ok(s.panes[`t${CLI_ADOPTION_MAX_PANES}`]);
});

test("a malformed file starts over instead of failing", () => {
  assert.deepEqual(normalizeCliAdoption({ version: 2 }), emptyCliAdoption());
  assert.deepEqual(normalizeCliAdoption("nope"), emptyCliAdoption());
  assert.deepEqual(
    normalizeCliAdoption({ version: 1, panes: { a: { agent: 7, commands: ["status", 1] } } }),
    { version: 1, panes: { a: { commands: ["status"] } } },
  );
});

test("store: updates racing the first load are all kept and flushed to disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-adoption-"));
  const file = join(dir, "cli-adoption.json");
  try {
    writeFileSync(file, JSON.stringify({ version: 1, panes: { old: { agent: "codex", launchedAt: 1 } } }));
    const store = createCliAdoptionStore(file, 60_000);
    await Promise.all([
      store.launched({ terminalId: "a", agent: "claude" }),
      store.called({ terminalId: "a", command: "capabilities" }),
      store.launched({ terminalId: "b", agent: "claude" }),
    ]);
    store.flush();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(onDisk.panes).sort(), ["a", "b", "old"]);
    assert.deepEqual(onDisk.panes.a.commands, ["capabilities"]);
    assert.deepEqual(await store.summary(), [
      { agent: "claude", panesLaunched: 2, panesThatCalledAya: 1, panesThatRanCapabilities: 1 },
      { agent: "codex", panesLaunched: 1, panesThatCalledAya: 0, panesThatRanCapabilities: 0 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: a missing file starts empty, and nothing to save writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-adoption-"));
  const file = join(dir, "none.json");
  try {
    const store = createCliAdoptionStore(file, 60_000);
    assert.deepEqual(await store.summary(), []);
    store.flush();
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
