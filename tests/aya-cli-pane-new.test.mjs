// `aya pane new` from the real CLI to the real control server: which project gets the pane
// (--project, the caller's pane, the cwd), its preset and name, and what is refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");

const cli = resolve("bin/aya");
const root = mkdtempSync(join(tmpdir(), "aya-pane-new-"));
const home = join(root, "home");
const outside = join(root, "elsewhere");
const LIBEVAL_DIR = join(root, "libeval");
const OTHER_DIR = join(root, "other");
for (const dir of [home, outside, LIBEVAL_DIR, OTHER_DIR]) mkdirSync(dir, { recursive: true });

const OTHER_WORKER = "c0ffee00-1234-4abc-8def-001122334433";
const PROJECTS = [
  { slug: "libeval", name: "libeval", directory: LIBEVAL_DIR, tabs: [] },
  { slug: "other", name: "other", directory: OTHER_DIR, tabs: [{ id: OTHER_WORKER, name: "worker", presetId: "claude" }] },
  { slug: "box", name: "box", directory: "/srv/box", remote: { host: "box" }, tabs: [] },
];
const PRESETS = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
];

const opened = [];
let nextId = 0;
const socket = join(root, "aya.sock");
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  // The real test runner may itself descend from a Codex daemon.
  processTable: async (pid) => new Map([[pid, { ppid: 1, command: "aya-cli-test" }]]),
  openProject: () => {},
  listProjects: async () => PROJECTS,
  teamPanes: {
    listProjects: async () => PROJECTS,
    listPresets: async () => PRESETS,
    presetInstalled: async (preset) => preset.id !== "codex",
    newPaneId: () => `new-${++nextId}`,
    openPanes: async (projectSlug, panes) => {
      opened.push({ projectSlug, panes });
    },
  },
});
test.after(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

function aya(args, { cwd = outside, env = {} } = {}) {
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", [cli, "pane", "new", ...args], {
      cwd,
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

// [label, args, options, the project, the pane opened]
const OPENS = [
  ["--project", ["claude", "--project", "other"], {}, "other", { presetId: "claude", name: "Claude Code" }],
  ["--name", ["claude", "--name", "reviewer two", "--project=libeval"], {}, "libeval", { presetId: "claude", name: "reviewer two" }],
  ["--name=value before the preset", ["--name=builder", "claude"], { cwd: OTHER_DIR }, "other", { presetId: "claude", name: "builder" }],
  ["the cwd's project", ["claude"], { cwd: LIBEVAL_DIR }, "libeval", { presetId: "claude", name: "Claude Code" }],
  ["the caller's pane beats the cwd", ["claude"], { cwd: LIBEVAL_DIR, env: { AYA_TERMINAL_ID: OTHER_WORKER } }, "other", { presetId: "claude", name: "Claude Code" }],
  ["AYA_PROJECT_SLUG", ["claude"], { env: { AYA_PROJECT_SLUG: "libeval" } }, "libeval", { presetId: "claude", name: "Claude Code" }],
  ["a name with a newline and ESC is one line", ["claude", "--name", "a\nb\u001b[31mc", "--project", "other"], {}, "other", { presetId: "claude", name: "a b [31mc" }],
  ["a name of controls only falls back to the preset's", ["claude", "--name", "\n", "--project", "other"], {}, "other", { presetId: "claude", name: "Claude Code" }],
  ["--project beats AYA_PROJECT_SLUG", ["claude", "--project", "other"], { env: { AYA_PROJECT_SLUG: "libeval" } }, "other", { presetId: "claude", name: "Claude Code" }],
];

test("pane new opens one pane in the right project and prints its id", async () => {
  for (const [label, args, options, slug, pane] of OPENS) {
    opened.length = 0;
    const r = await aya(args, options);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.equal(opened.length, 1, label);
    const [sent] = opened[0].panes;
    assert.equal(opened[0].projectSlug, slug, label);
    assert.deepEqual(sent, { id: sent.id, teamLaunch: false, ...pane }, label);
    assert.equal(r.stdout, `${sent.id}\n`, label);
  }
});

// [label, args, options, error pattern]
const REFUSALS = [
  ["no preset", [], {}, /Usage/],
  ["two presets", ["claude", "codex"], {}, /Usage/],
  ["--name without a value", ["claude", "--name"], {}, /Usage/],
  ["an empty --name=", ["claude", "--name="], {}, /Usage/],
  ["an unknown flag", ["claude", "--force"], {}, /Usage/],
  ["an unknown preset", ["nope", "--project", "other"], {}, /no preset "nope"; presets: claude, codex; nothing was opened/],
  ["a preset not installed", ["codex", "--project", "other"], {}, /preset "codex" \(Codex\) is not installed; nothing was opened/],
  ["an unknown project", ["claude", "--project", "nope"], { cwd: LIBEVAL_DIR }, /no project "nope"; projects: libeval, other, box; nothing was opened/],
  ["a remote project", ["claude", "--project", "box"], {}, /project box is remote; aya pane new works only on local projects; nothing was opened/],
  ["no project at all", ["claude"], {}, /pass --project <slug>; nothing was opened/],
];

test("pane new refuses before it opens anything", async () => {
  for (const [label, args, options, error] of REFUSALS) {
    opened.length = 0;
    const r = await aya(args, options);
    assert.notEqual(r.status, 0, label);
    assert.equal(r.stdout, "", label);
    assert.match(r.stderr, error, label);
    assert.equal(opened.length, 0, label);
  }
});
