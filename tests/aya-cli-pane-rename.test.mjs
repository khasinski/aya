// `aya pane rename` from the real CLI to the real control server: the target resolves as for
// pane read/send, the window is asked to rename that pane, and nothing is asked on a refusal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { PaneOpenTimeout } = await import("../dist-electron/team-panes.js");

const cli = resolve("bin/aya");
const root = mkdtempSync(join(tmpdir(), "aya-pane-rename-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });

const LIBEVAL_WORKER = "3f1c2a9e-0d4b-4e8a-9c51-7b2d6e0f1a11";
const OTHER_WORKER = "c0ffee00-1234-4abc-8def-001122334433";
const tab = (id, name) => ({ id, name, presetId: "claude" });
const PROJECTS = [
  { slug: "libeval", name: "libeval", directory: join(root, "libeval"), tabs: [tab(LIBEVAL_WORKER, "worker")] },
  { slug: "other", name: "other", directory: join(root, "other"), tabs: [tab(OTHER_WORKER, "worker")] },
];

const changes = [];
let windowAnswer = async () => {};
const socket = join(root, "aya.sock");
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  openProject: () => {},
  listProjects: async () => PROJECTS,
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
    const child = spawn("/bin/sh", [cli, "pane", "rename", ...args], {
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

// [label, args, env, the pane renamed]
const RENAMES = [
  ["--project", ["worker", "auth fix", "--project", "other"], {}, { projectSlug: "other", paneId: OTHER_WORKER }],
  ["--project=slug first", ["--project=libeval", "worker", "auth fix"], {}, { projectSlug: "libeval", paneId: LIBEVAL_WORKER }],
  ["AYA_PROJECT_SLUG", ["worker", "auth fix"], { AYA_PROJECT_SLUG: "libeval" }, { projectSlug: "libeval", paneId: LIBEVAL_WORKER }],
  ["id from pane list", [OTHER_WORKER, "auth fix"], {}, { projectSlug: "other", paneId: OTHER_WORKER }],
];

test("pane rename asks the window to rename the pane the target names", async () => {
  for (const [label, args, env, pane] of RENAMES) {
    changes.length = 0;
    const r = await aya(args, env);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.deepEqual(changes, [{ ...pane, change: { rename: "auth fix" } }], label);
    assert.equal(r.stdout, "renamed worker to auth fix\n", label);
  }
});

// [label, args, error pattern]
const REFUSALS = [
  ["no name", ["worker"], /Usage/],
  ["an empty name", ["worker", ""], /Usage/],
  ["three words unquoted", ["worker", "auth", "fix"], /Usage/],
  ["a blank name", ["worker", "   ", "--project", "other"], /pane-rename requires name/],
  ["a name of controls only", ["worker", "\n\u001b", "--project", "other"], /the name has no visible characters; nothing was renamed/],
  ["a name over 200 characters", ["worker", "x".repeat(201), "--project", "other"], /the name is 201 characters, the most is 200; nothing was renamed/],
  ["a name in two projects", ["worker", "x"], /ambiguous/],
  ["an unknown pane", ["nope", "x"], /no pane named "nope"/],
];

test("pane rename refuses before it asks the window", async () => {
  for (const [label, args, error] of REFUSALS) {
    changes.length = 0;
    const r = await aya(args);
    assert.notEqual(r.status, 0, label);
    assert.equal(r.stdout, "", label);
    assert.match(r.stderr, error, label);
    assert.deepEqual(changes, [], label);
  }
});

test("pane rename sends a name with line breaks and escapes as one plain line", async () => {
  changes.length = 0;
  const r = await aya(["worker", "x\n  shell 2   shell  tab-forged\u001b[31m‮", "--project", "other"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(changes.map((c) => c.change), [{ rename: "x   shell 2   shell  tab-forged [31m" }]);
  assert.equal(r.stdout, "renamed worker to x   shell 2   shell  tab-forged [31m\n");
});

test("pane rename passes on the window's refusal, and says a missed deadline may still rename", async () => {
  try {
    windowAnswer = async () => {
      throw new Error(`pane ${OTHER_WORKER} is not open in this window`);
    };
    const refused = await aya(["worker", "x", "--project", "other"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /is not open in this window/);

    windowAnswer = async () => {
      throw new PaneOpenTimeout(Promise.resolve());
    };
    const late = await aya(["worker", "x", "--project", "other"]);
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /did not answer in time; the pane may still be renamed/);
  } finally {
    windowAnswer = async () => {};
  }
});
