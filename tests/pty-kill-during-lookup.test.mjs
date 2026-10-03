// Closing a tab while its spawn is still in its async preflight (the command
// probe, opencode's session lookup) must not leave a child behind: the kill
// finds no PTY yet, so the spawn has to notice it before starting one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-kill-lookup-")));
const bin = join(root, "bin");
const cwd = join(root, "wt");
mkdirSync(bin);
mkdirSync(cwd);
mkdirSync(join(root, "home"));
const lookupStarted = join(root, "lookup-started");
const lookupRelease = join(root, "lookup-release");
writeFileSync(
  join(bin, "opencode"),
  `#!/bin/sh\nif [ "$1" = session ]; then
    touch '${lookupStarted}'
    while [ ! -f '${lookupRelease}' ]; do sleep 0.01; done
    echo "[]"; exit 0
  fi
  exec sleep 30\n`,
);
chmodSync(join(bin, "opencode"), 0o755);
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "xdg-data");
process.env.SHELL = "/bin/sh";
process.env.PATH = `${bin}:/usr/bin:/bin`;

const { activePtyCount, isPtyStarting, killPty, spawnPty } = await import("../dist-electron/pty.js");

// Keep the lookup suspended until the test has killed/restarted the pane.
// A marker proves the lookup is underway; it answers only once released.
test.beforeEach(() => {
  rmSync(lookupStarted, { force: true });
  rmSync(lookupRelease, { force: true });
});
test.afterEach(() => releaseLookup());
const releaseLookup = () => writeFileSync(lookupRelease, "");
async function duringLookup() {
  const deadline = Date.now() + 10_000;
  while (!existsSync(lookupStarted) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(existsSync(lookupStarted), true, "the session lookup has started");
}

test("a kill that lands during the opencode lookup stops the spawn", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "kill-during-lookup";
  const spawning = spawnPty({ ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 }, sink);
  await duringLookup();
  killPty(ptyId);
  releaseLookup();
  await spawning;
  const log = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8");
  const started = activePtyCount();
  if (started) killPty(ptyId);
  assert.equal(started, 0, "no child may outlive the closed tab");
  assert.doesNotMatch(log, /"ev":"spawn","ptyId":"kill-during-lookup"/);
  assert.match(log, /"ev":"spawn-cancelled","ptyId":"kill-during-lookup"/);
});

const output = (sink) => sink.events.filter((e) => e.type === "data").map((e) => e.chunk).join("");

async function waitForOutput(sink, marker) {
  const deadline = Date.now() + 10_000;
  while (!output(sink).includes(marker) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("a restart during the lookup starts the new spawn, never the killed one", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "kill-then-restart";
  const first = spawnPty({ ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 }, sink);
  await duringLookup();
  killPty(ptyId);
  const second = spawnPty({ ptyId, command: "echo restarted-marker", cwd, cols: 80, rows: 24 }, sink);
  releaseLookup();
  await first;
  await second;
  await waitForOutput(sink, "restarted-marker");
  killPty(ptyId);
  const log = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8");
  const spawns = log.match(/"ev":"spawn","ptyId":"kill-then-restart",[^\n]*/g) ?? [];
  assert.match(output(sink), /restarted-marker/, "the restarted tab must get a process");
  assert.equal(spawns.length, 1, "only the restart's child starts");
  assert.match(spawns[0], /restarted-marker/);
  assert.doesNotMatch(log, /"ev":"spawn-dropped-in-flight","ptyId":"kill-then-restart"/);
});

test("a restart of an opencode pane during its lookup resumes (every agent restarts)", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "kill-then-restart-same";
  const req = { ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 };
  const first = spawnPty(req, sink);
  await duringLookup();
  killPty(ptyId);
  const second = spawnPty(req, sink);
  releaseLookup();
  await Promise.all([first, second]);
  const started = activePtyCount();
  killPty(ptyId);
  assert.equal(started, 1, "the restart must leave exactly one live child");
  const log = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8");
  assert.match(log, /"ev":"opencode-session-none","ptyId":"kill-then-restart-same"/);
});

test("a tab closed again while its restart waits starts nothing", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "kill-restart-kill";
  const req = { ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 };
  const first = spawnPty(req, sink);
  await duringLookup();
  killPty(ptyId);
  const second = spawnPty(req, sink);
  // A re-mount while the restart waits is a double mount of the restart.
  const third = spawnPty(req, sink);
  killPty(ptyId);
  releaseLookup();
  await Promise.all([first, second, third]);
  const started = activePtyCount();
  if (started) killPty(ptyId);
  assert.equal(started, 0, "no child may outlive the closed tab");
  const log = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8");
  assert.match(log, /"ev":"spawn-dropped-in-flight","ptyId":"kill-restart-kill"/);
});

test("a tab reopened after its cancelled spawn returned does start (ids are reused)", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "kill-then-reopen";
  const first = spawnPty({ ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 }, sink);
  await duringLookup();
  killPty(ptyId);
  releaseLookup();
  await first;
  await spawnPty({ ptyId, command: "echo reopened-marker", cwd, cols: 80, rows: 24 }, sink);
  await waitForOutput(sink, "reopened-marker");
  killPty(ptyId);
  assert.match(output(sink), /reopened-marker/);
});

test("a kill with no spawn under way still drops the next spawn of that id", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "kill-before-spawn";
  killPty(ptyId);
  await spawnPty({ ptyId, command: "echo never", cwd, cols: 80, rows: 24 }, sink);
  assert.equal(activePtyCount(), 0);
  const log = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8");
  assert.match(log, /"ev":"spawn-dropped-pending-kill","ptyId":"kill-before-spawn"/);
});

test("a pane in its lookup is starting, and stops being so once killed", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "starting-during-lookup";
  const spawning = spawnPty({ ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 }, sink);
  await duringLookup();
  assert.equal(isPtyStarting(ptyId), true, "a team must not treat a starting pane as gone");
  killPty(ptyId);
  assert.equal(isPtyStarting(ptyId), false);
  releaseLookup();
  await spawning;
});
