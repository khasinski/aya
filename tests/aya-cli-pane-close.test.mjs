// `aya pane close` from the real CLI to the real control server: the target resolves as for
// pane read/send, a pane with work in flight, of another project or in a team role is refused
// without --force, a pane never closes itself, and the window is asked to close only what passed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { PaneOpenTimeout } = await import("../dist-electron/team-panes.js");
const { openTeamStore } = await import("../dist-electron/team-store.js");

const cli = resolve("bin/aya");
const root = mkdtempSync(join(tmpdir(), "aya-pane-close-"));
const home = join(root, "home");
const teamHome = join(root, "team-home");
mkdirSync(home, { recursive: true });

const LIBEVAL_WORKER = "3f1c2a9e-0d4b-4e8a-9c51-7b2d6e0f1a11";
const OTHER_WORKER = "c0ffee00-1234-4abc-8def-001122334433";
const OTHER_HELPER = "c0ffee00-1234-4abc-8def-001122334455";
const OTHER_LEAD = "c0ffee00-1234-4abc-8def-001122334466";
const tab = (id, name) => ({ id, name, presetId: "claude" });
const PROJECTS = [
  { slug: "libeval", name: "libeval", directory: join(root, "libeval"), tabs: [tab(LIBEVAL_WORKER, "worker")] },
  {
    slug: "other",
    name: "other",
    directory: join(root, "other"),
    tabs: [tab(OTHER_WORKER, "worker"), tab(OTHER_HELPER, "helper"), tab(OTHER_LEAD, "lead")],
  },
];

mkdirSync(join(teamHome, "teams", "other", "review"), { recursive: true });
writeFileSync(join(teamHome, "teams", "other", "review", "saved.md"), "# review\n\n## Role: lead\nMust not: guess\nLeads.\n\n## Lead\nlead\n");
await openTeamStore(teamHome, "other", "review").assign("lead", OTHER_LEAD);

const changes = [];
const stateOf = new Map();
let windowAnswer = async () => {};
const socket = join(root, "aya.sock");
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  // The real test runner may itself descend from a Codex daemon.
  processTable: async (pid) => new Map([[pid, { ppid: 1, command: "aya-cli-test" }]]),
  openProject: () => {},
  listProjects: async () => PROJECTS,
  team: { teamHome },
  paneState: async (id) => ({ state: stateOf.get(id) ?? "idle" }),
  changePane: async (projectSlug, paneId, change) => {
    changes.push({ projectSlug, paneId, change });
    await windowAnswer();
  },
});
test.after(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

function aya(args, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", [cli, "pane", "close", ...args], {
      cwd: home,
      env: { ...envWithoutAya(), HOME: home, AYA_SOCKET: socket, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

test("pane close closes the pane the target names", async () => {
  for (const [label, args, env, pane] of [
    ["--project", ["worker", "--project", "other"], {}, { projectSlug: "other", paneId: OTHER_WORKER }],
    ["AYA_PROJECT_SLUG", ["worker"], { AYA_PROJECT_SLUG: "libeval" }, { projectSlug: "libeval", paneId: LIBEVAL_WORKER }],
    ["id from pane list", [OTHER_WORKER], {}, { projectSlug: "other", paneId: OTHER_WORKER }],
    ["from another pane of the project", ["worker", "--project", "other"], { AYA_TERMINAL_ID: OTHER_HELPER }, { projectSlug: "other", paneId: OTHER_WORKER }],
  ]) {
    changes.length = 0;
    const r = await aya(args, env);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.deepEqual(changes, [{ ...pane, change: { close: true } }], label);
    assert.equal(r.stdout, "closed worker\n", label);
  }
});

test("without --force only an idle or exited pane closes, judged by the target's own state", async () => {
  try {
    // The helper is busy throughout: a state read of the wrong pane would refuse the worker.
    stateOf.set(OTHER_HELPER, "busy");
    for (const state of ["idle", "stopped"]) {
      stateOf.set(OTHER_WORKER, state);
      changes.length = 0;
      const r = await aya([OTHER_WORKER]);
      assert.equal(r.status, 0, `${state}: ${r.stderr}`);
      assert.equal(changes.length, 1, state);
    }
    stateOf.set(OTHER_HELPER, "idle");
    for (const state of ["shell", "busy", "starting", "held", "unknown", "waiting"]) {
      stateOf.set(OTHER_WORKER, state);
      changes.length = 0;
      const refused = await aya([OTHER_WORKER]);
      assert.notEqual(refused.status, 0, state);
      assert.match(refused.stderr, new RegExp(`worker is ${state}; closing it stops what runs in it; pass --force .*nothing was closed`), state);
      assert.deepEqual(changes, [], state);

      const forced = await aya([OTHER_WORKER, "--force"]);
      assert.equal(forced.status, 0, `${state} --force: ${forced.stderr}`);
      assert.equal(changes.length, 1, `${state} --force`);
    }
  } finally {
    stateOf.clear();
  }
});

test("a pane of another project or in a team role needs --force", async () => {
  for (const [label, args, env, error] of [
    ["another project", ["worker", "--project", "libeval"], { AYA_TERMINAL_ID: OTHER_HELPER }, /worker is in project libeval, not in this pane's project other; pass --force/],
    ["a team role", ["lead"], {}, /lead plays lead in team review; closing it leaves the role without a pane; pass --force/],
  ]) {
    changes.length = 0;
    const refused = await aya(args, env);
    assert.notEqual(refused.status, 0, label);
    assert.match(refused.stderr, error, label);
    assert.deepEqual(changes, [], label);

    const forced = await aya([...args, "--force"], env);
    assert.equal(forced.status, 0, `${label} --force: ${forced.stderr}`);
    assert.equal(changes.length, 1, `${label} --force`);
  }
});

test("a pane never closes itself, even with --force", async () => {
  for (const args of [["helper"], ["helper", "--force"]]) {
    changes.length = 0;
    const r = await aya([...args, "--project", "other"], { AYA_TERMINAL_ID: OTHER_HELPER });
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, /helper is the pane running this command; close it from another pane or the tab bar; nothing was closed/);
    assert.deepEqual(changes, [], args.join(" "));
  }
});

// [label, args, error pattern]
const REFUSALS = [
  ["no target", [], /Usage/],
  ["two targets", ["worker", "solo"], /Usage/],
  ["--force twice", ["worker", "--force", "--force"], /Usage/],
  ["an unknown flag", ["worker", "--yes"], /Usage/],
  ["a name in two projects", ["worker"], /ambiguous/],
  ["an unknown pane", ["nope"], /no pane named "nope"/],
];

test("pane close refuses a bad target before it asks the window", async () => {
  for (const [label, args, error] of REFUSALS) {
    changes.length = 0;
    const r = await aya(args);
    assert.notEqual(r.status, 0, label);
    assert.equal(r.stdout, "", label);
    assert.match(r.stderr, error, label);
    assert.deepEqual(changes, [], label);
  }
});

test("pane close passes on the window's refusal, and says a missed deadline may still close", async () => {
  try {
    windowAnswer = async () => {
      throw new Error("worker was not closed");
    };
    const refused = await aya([OTHER_WORKER]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /worker was not closed/);

    windowAnswer = async () => {
      throw new PaneOpenTimeout(Promise.resolve());
    };
    const late = await aya([OTHER_WORKER]);
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /did not answer in time; the pane may still be closed/);
  } finally {
    windowAnswer = async () => {};
  }
});
