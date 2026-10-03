// `aya pane read/send/list` from the real CLI to the real control server: which pane a
// target picks, over name unique / in two projects, --project before / after, id, cwd.
// The ambiguity error's advice must be advice that works (a live run found it did not).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");

const cli = resolve("bin/aya");
const root = mkdtempSync(join(tmpdir(), "aya-pane-target-"));
const home = join(root, "home");
const outside = join(root, "elsewhere");
const LIBEVAL_DIR = join(root, "libeval");
const OTHER_DIR = join(root, "other");
for (const dir of [home, outside, LIBEVAL_DIR, OTHER_DIR]) mkdirSync(dir, { recursive: true });

const LIBEVAL_WORKER = "3f1c2a9e-0d4b-4e8a-9c51-7b2d6e0f1a11";
const LIBEVAL_SOLO = "8a7b6c5d-1e2f-4a3b-8c9d-0e1f2a3b4c22";
const OTHER_WORKER = "c0ffee00-1234-4abc-8def-001122334433";
const DUP_A = "d1d1d1d1-0000-4000-8000-000000000a01";
const DUP_B = "d2d2d2d2-0000-4000-8000-000000000b02";

const tab = (id, name) => ({ id, name, presetId: "claude" });
const PROJECTS = [
  { slug: "libeval", name: "libeval", directory: LIBEVAL_DIR, tabs: [tab(LIBEVAL_WORKER, "worker"), tab(LIBEVAL_SOLO, "solo")] },
  { slug: "other", name: "other", directory: OTHER_DIR, tabs: [tab(OTHER_WORKER, "worker"), tab(DUP_A, "twin"), tab(DUP_B, "twin")] },
];

const written = [];
const socket = join(root, "aya.sock");
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  openProject: () => {},
  listProjects: async () => PROJECTS,
  readPane: async (id) => `screen of ${id}\n`,
  writePane: async (id, data) => {
    written.push({ id, data });
    return true;
  },
});
test.after(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

function aya(args, { shell = "/bin/sh", cwd = outside, slug } = {}) {
  return new Promise((done, fail) => {
    const env = { ...envWithoutAya(), HOME: home, AYA_SOCKET: socket, ...(slug ? { AYA_PROJECT_SLUG: slug } : {}) };
    const child = spawn(shell, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

// [label, args, the pane read or null for an error, error pattern]
const READS = [
  ["unique name", ["solo"], LIBEVAL_SOLO],
  ["name in two projects", ["worker"], null, /ambiguous/],
  ["--project before the name", ["--project", "libeval", "worker"], LIBEVAL_WORKER],
  ["--project after the name", ["worker", "--project", "libeval"], LIBEVAL_WORKER],
  ["--project=slug", ["--project=other", "worker"], OTHER_WORKER],
  ["--project scoping a unique name elsewhere", ["solo", "--project", "other"], null, /no pane named "solo"/],
  ["id from pane list", [OTHER_WORKER], OTHER_WORKER],
  ["id with its project", [LIBEVAL_WORKER, "--project", "libeval"], LIBEVAL_WORKER],
  ["id outside the given project", [LIBEVAL_WORKER, "--project", "other"], null, /no pane named/],
  ["id prefix is not a guess", [OTHER_WORKER.slice(0, 8)], null, /no pane named/],
  ["--project without a slug", ["worker", "--project"], null, /Usage/],
  ["two targets", ["worker", "solo"], null, /Usage/],
];

for (const shell of CLI_SHELLS) {
  for (const [where, cwd] of [["outside a project", outside], ["inside a project", LIBEVAL_DIR]]) {
    test(`pane read under ${shell}, ${where}`, shellOptions(shell), async () => {
      for (const [label, args, want, error] of READS) {
        const r = await aya(["pane", "read", ...args], { shell, cwd });
        if (want) {
          assert.equal(r.status, 0, `${label}: ${r.stderr}`);
          assert.equal(r.stdout, `screen of ${want}\n`, label);
        } else {
          assert.notEqual(r.status, 0, label);
          assert.equal(r.stdout, "", label);
          assert.match(r.stderr, error, label);
        }
      }
    });
  }
}

test("the ambiguity error advises --project only when the matches are in different projects", async () => {
  const across = await aya(["pane", "read", "worker"]);
  assert.match(across.stderr, /--project/);
  assert.match(across.stderr, /id/);
  const within = await aya(["pane", "read", "twin"]);
  assert.match(within.stderr, /ambiguous/);
  assert.doesNotMatch(within.stderr, /--project/);
  assert.match(within.stderr, /id/);
  // The advice for the same-project case works: either id reads its pane.
  assert.equal((await aya(["pane", "read", DUP_B])).stdout, `screen of ${DUP_B}\n`);
});

test("--project beats the pane's own AYA_PROJECT_SLUG; without it the slug scopes", async () => {
  assert.equal((await aya(["pane", "read", "worker"], { slug: "other" })).stdout, `screen of ${OTHER_WORKER}\n`);
  assert.equal(
    (await aya(["pane", "read", "worker", "--project", "libeval"], { slug: "other" })).stdout,
    `screen of ${LIBEVAL_WORKER}\n`,
  );
});

// [label, args, pane typed into or null, text typed]
const SENDS = [
  ["name in two projects", ["worker", "hi"], null],
  ["--project before the name", ["--project", "libeval", "worker", "hi"], LIBEVAL_WORKER, "hi"],
  ["--project between name and text", ["worker", "--project", "libeval", "hi there"], LIBEVAL_WORKER, "hi there"],
  ["--project after the text", ["worker", "hi", "--project", "other"], OTHER_WORKER, "hi"],
  ["--project=slug with --no-submit", ["--project=other", "worker", "--no-submit", "hi"], OTHER_WORKER, "hi"],
  ["id from pane list", [LIBEVAL_SOLO, "hi"], LIBEVAL_SOLO, "hi"],
  ["--project after -- is text", ["--project", "libeval", "worker", "--", "--project", "x"], LIBEVAL_WORKER, "--project x"],
];

test("pane send resolves its target the same way", async () => {
  for (const [label, args, want, text] of SENDS) {
    written.length = 0;
    const r = await aya(["pane", "send", ...args]);
    if (want) {
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.deepEqual([...new Set(written.map((w) => w.id))], [want], label);
      assert.ok(written[0].data.includes(text), `${label}: ${JSON.stringify(written)}`);
      assert.ok(!written.some((w) => w.data.includes("libeval") || w.data.includes("other")), `${label}: the slug was typed`);
    } else {
      assert.notEqual(r.status, 0, label);
      assert.match(r.stderr, /ambiguous/, label);
      assert.deepEqual(written, [], label);
    }
  }
});

test("pane list --project lists that project, before or after list", async () => {
  for (const args of [["list", "--project", "libeval"], ["--project", "libeval", "list"]]) {
    const r = await aya(["pane", ...args]);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(LIBEVAL_SOLO));
    assert.doesNotMatch(r.stdout, new RegExp(OTHER_WORKER));
  }
  const all = await aya(["pane", "list"]);
  assert.match(all.stdout, new RegExp(OTHER_WORKER));
  assert.match(all.stdout, new RegExp(LIBEVAL_SOLO));
});
