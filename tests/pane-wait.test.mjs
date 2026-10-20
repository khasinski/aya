import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlServerOn } from "../dist-electron/control.js";
import { waitForPaneTargets, formatPaneWaitReply } from "../dist-electron/pane-wait.js";
import { parseControlRequest } from "../dist-electron/control-protocol.js";

function state(name, waiting = false, exited = false) {
  return { state: name, exited, hold: null, busy: name === "busy", waiting, generation: "g", rules: { available: true }, evidence: [] };
}

function subject(initial) {
  const states = new Map(Object.entries(initial));
  const listeners = new Map();
  return {
    readState: async (id) => states.get(id) ?? state("unknown", null),
    subscribe: (id, listener) => {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },
    update(id, value) {
      states.set(id, value);
      for (const listener of listeners.get(id) ?? []) listener(value);
    },
    listenerCount(id) { return listeners.get(id)?.size ?? 0; },
  };
}

test("pane wait handles busy-to-idle, waiting, exit, all, any and timeout", async (t) => {
  const s = subject({ a: state("busy"), b: state("waiting", true), c: state("stopped") });
  const targets = [
    { terminalId: "a", name: "Builder" },
    { terminalId: "b", name: "Reviewer" },
    { terminalId: "c", name: "Old shell" },
  ];
  const start = (ids, options) => waitForPaneTargets(ids.map((id) => targets.find((x) => x.terminalId === id)), {
    until: options.until, any: options.any ?? false, timeoutMs: options.timeoutMs ?? 100,
    readState: s.readState, subscribe: s.subscribe,
  });

  await t.test("busy becomes idle and all targets must meet the condition", async () => {
    const pending = start(["a", "b"], { until: ["idle"] });
    s.update("b", state("idle"));
    s.update("a", state("idle"));
    assert.deepEqual(await pending, { met: true, matched: ["Builder", "Reviewer"], pending: [] });
  });
  await t.test("waiting uses pane state; unstarted and failed-to-start panes are not exited", async () => {
    const s2 = subject({ b: state("waiting", true), c: state("stopped"), d: state("stopped") });
    assert.equal((await waitForPaneTargets([targets[1]], { until: ["waiting"], any: false, timeoutMs: 100, readState: s2.readState, subscribe: s2.subscribe })).met, true);
    for (const id of ["c", "d"]) {
      // A missing process and a spawn-failed notification are both stopped,
      // but neither is evidence that a process exited.
      s2.update(id, state("stopped", false, false));
      const unstarted = await waitForPaneTargets([{ terminalId: id, name: id }], { until: ["exited"], any: false, timeoutMs: 5, readState: s2.readState, subscribe: s2.subscribe });
      assert.equal(unstarted.met, false);
      assert.deepEqual(unstarted.pending, [id]);
    }
  });
  await t.test("an explicit process exit event satisfies exited", async () => {
    const s2 = subject({ c: state("stopped") });
    const pending = waitForPaneTargets([targets[2]], { until: ["exited"], any: false, timeoutMs: 100, readState: s2.readState, subscribe: s2.subscribe });
    s2.update("c", state("stopped", false, true));
    assert.deepEqual(await pending, { met: true, matched: ["Old shell"], pending: [] });
  });
  await t.test("--any returns when the first target matches", async () => {
    const s2 = subject({ a: state("busy"), b: state("idle") });
    const pending = waitForPaneTargets(targets.slice(0, 2), {
      until: ["idle"], any: true, timeoutMs: 100,
      readState: s2.readState, subscribe: s2.subscribe,
    });
    assert.deepEqual(await pending, { met: true, matched: ["Reviewer"], pending: ["Builder"] });
  });
  await t.test("timeout names the pane still waiting", async () => {
    const s3 = subject({ a: state("busy") });
    const pending = await waitForPaneTargets([targets[0]], { until: ["idle"], any: false, timeoutMs: 5, readState: s3.readState, subscribe: s3.subscribe });
    assert.equal(pending.met, false);
    assert.deepEqual(pending.pending, ["Builder"]);
    assert.equal(formatPaneWaitReply(pending, [targets[0]], ["idle"], 5).exitCode, 1);
  });
  await t.test("Ctrl+C cancellation removes subscriptions without waiting for the deadline", async () => {
    const s4 = subject({ a: state("busy") });
    const controller = new AbortController();
    const pending = waitForPaneTargets([targets[0]], { until: ["idle"], any: false, timeoutMs: 60_000, signal: controller.signal, readState: s4.readState, subscribe: s4.subscribe });
    controller.abort();
    assert.equal((await pending).met, false);
    assert.equal(s4.listenerCount("a"), 0);
  });
});

test("pane-wait control payload is bounded and has a closed condition set", () => {
  const valid = { type: "pane-wait", targets: ["reviewer"], until: ["idle", "waiting"], any: true, timeoutMs: 1000 };
  assert.deepEqual(parseControlRequest(valid), { ...valid, projectSlug: undefined });
  assert.throws(() => parseControlRequest({ ...valid, until: ["unknown"] }), /pane-wait.until/);
  assert.throws(() => parseControlRequest({ ...valid, timeoutMs: 86_400_001 }), /timeoutMs/);
  assert.throws(() => parseControlRequest({ ...valid, targets: Array(65).fill("reviewer") }), /targets/);
});

function cli(socketPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.cwd(), "bin/aya"), args, {
      env: { ...process.env, AYA_SOCKET: socketPath, AYA_PROJECT_SLUG: "p" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI parses pane wait flags and preserves timeout / bad-target exit codes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-pane-wait-cli-"));
  const socketPath = join(dir, "control.sock");
  const current = new Map([["pane-1", state("busy")], ["pane-2", state("idle")], ["pane-3", state("stopped")]]);
  const listeners = new Map();
  const publish = (id, next) => {
    current.set(id, next);
    for (const listener of listeners.get(id) ?? []) listener(next);
  };
  const server = startControlServerOn(socketPath, {
    getWindow: () => null,
    openProject() {},
    listProjects: async () => [{ slug: "p", name: "Project", directory: dir, tabs: [
      { id: "pane-1", name: "Reviewer", presetId: "claude" },
      { id: "pane-2", name: "Builder", presetId: "codex" },
      { id: "pane-3", name: "Old shell", presetId: "shell" },
    ] }],
    paneState: async (id) => current.get(id),
    subscribePaneState: (id, listener) => {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },
  });
  t.after(() => { server(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(); });
    probe.once("error", reject);
  });

  const becomesIdle = cli(socketPath, ["pane", "wait", "Reviewer", "--until", "idle", "--timeout", "2"]);
  setTimeout(() => publish("pane-1", state("idle")), 20);
  const idleReply = await becomesIdle;
  assert.equal(idleReply.code, 0);
  assert.match(idleReply.stdout, /Reached idle for "Reviewer"/);

  const allTargets = await cli(socketPath, ["pane", "wait", "Reviewer", "Builder", "--until", "idle", "--timeout", "1"]);
  assert.equal(allTargets.code, 0);
  assert.match(allTargets.stdout, /"Reviewer", "Builder"/);

  publish("pane-1", state("busy"));
  publish("pane-2", state("busy"));
  const anyTarget = cli(socketPath, ["pane", "wait", "Reviewer", "Builder", "--until", "waiting", "--any", "--timeout", "2"]);
  setTimeout(() => publish("pane-2", state("waiting", true)), 20);
  const anyReply = await anyTarget;
  assert.equal(anyReply.code, 0);
  assert.match(anyReply.stdout, /Reached waiting for "Builder"/);

  const unstarted = await cli(socketPath, ["pane", "--project", "p", "wait", "pane:pane-3", "--until", "exited", "--timeout", "0"]);
  assert.equal(unstarted.code, 1);
  assert.match(unstarted.stdout, /Timed out/);

  const exitedWait = cli(socketPath, ["pane", "--project", "p", "wait", "pane:pane-3", "--until", "exited", "--timeout", "1"]);
  setTimeout(() => publish("pane-3", state("stopped", false, true)), 20);
  const exited = await exitedWait;
  assert.equal(exited.code, 0);
  assert.match(exited.stdout, /"Old shell"/);

  publish("pane-1", state("busy"));
  const timeout = await cli(socketPath, ["pane", "wait", "Reviewer", "--until", "idle,waiting", "--any", "--timeout", "0"]);
  assert.equal(timeout.code, 1);
  assert.match(timeout.stdout, /Timed out/);
  assert.match(timeout.stdout, /Reviewer/);

  const bad = await cli(socketPath, ["pane", "wait", "does-not-exist", "--timeout", "0"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /no pane named/);

  const malformed = await cli(socketPath, ["pane", "wait", "Reviewer", "--until", "immediately"]);
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /Usage:/);
});
