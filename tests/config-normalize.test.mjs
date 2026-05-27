// Tab-shape migration: pre-presets aya stored `kind: "claude" | "codex" | "shell"`;
// post-presets uses `presetId: string`. The loader must accept both and
// emit the new shape with `name` backfilled when missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeTab } from "../dist-electron/config.js";

const execFileAsync = promisify(execFile);

test("normalizes a new-format tab (presetId + name)", () => {
  const out = normalizeTab({
    id: "abc",
    presetId: "claude",
    name: "main-claude",
  });
  assert.deepEqual(out, { id: "abc", presetId: "claude", name: "main-claude" });
});

test("migrates old-format tab (`kind` → `presetId`)", () => {
  const out = normalizeTab({ id: "abc", kind: "codex", name: "feature-branch" });
  assert.deepEqual(out, {
    id: "abc",
    presetId: "codex",
    name: "feature-branch",
  });
});

test("backfills name from presetId when missing", () => {
  const out = normalizeTab({ id: "abc", kind: "shell" });
  assert.deepEqual(out, { id: "abc", presetId: "shell", name: "shell" });
});

test("backfills name when the existing name is blank", () => {
  const out = normalizeTab({ id: "abc", presetId: "claude", name: "   " });
  assert.equal(out.name, "claude");
});

test("accepts arbitrary presetIds (user-defined presets)", () => {
  const out = normalizeTab({ id: "abc", presetId: "my-custom-preset" });
  assert.equal(out?.presetId, "my-custom-preset");
});

test("rejects tab without id", () => {
  assert.equal(normalizeTab({ presetId: "shell" }), null);
});

test("rejects tab without presetId or kind", () => {
  assert.equal(normalizeTab({ id: "abc" }), null);
  assert.equal(normalizeTab({ id: "abc", kind: "" }), null);
  assert.equal(normalizeTab({ id: "abc", presetId: "" }), null);
});

test("rejects non-object input", () => {
  assert.equal(normalizeTab(null), null);
  assert.equal(normalizeTab(undefined), null);
  assert.equal(normalizeTab("string"), null);
  assert.equal(normalizeTab(42), null);
});

test("migrates project order/open files into projects-state.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-state-"));
  try {
    await writeFile(path.join(dir, "projects-order.json"), `["a","b"]\n`);
    await writeFile(path.join(dir, "open-projects.json"), `["b"]\n`);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "-e",
        `
          const fs = require("node:fs");
          const { listProjectState } = require("./dist-electron/config.js");
          const { PROJECTS_STATE_FILE } = require("./dist-electron/paths.js");
          (async () => {
            const state = await listProjectState();
            const persisted = JSON.parse(fs.readFileSync(PROJECTS_STATE_FILE, "utf8"));
            console.log(JSON.stringify({ state, persisted }));
          })().catch((err) => {
            console.error(err);
            process.exit(1);
          });
        `,
      ],
      { cwd: process.cwd(), env: { ...process.env, AYA_HOME: dir } },
    );
    const { state, persisted } = JSON.parse(stdout);
    const expected = {
      version: 1,
      order: ["a", "b"],
      open: ["b"],
      recent: ["a", "b"],
    };
    assert.deepEqual(state, expected);
    assert.deepEqual(persisted, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("projects-state.json wins over legacy order/open files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-state-"));
  try {
    await writeFile(path.join(dir, "projects-order.json"), `["legacy"]\n`);
    await writeFile(path.join(dir, "open-projects.json"), `["legacy"]\n`);
    await writeFile(
      path.join(dir, "projects-state.json"),
      JSON.stringify({ version: 1, order: ["new"], open: [], recent: ["new"] }),
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "-e",
        `
          const { listProjectState } = require("./dist-electron/config.js");
          listProjectState()
            .then((state) => console.log(JSON.stringify(state)))
            .catch((err) => {
              console.error(err);
              process.exit(1);
            });
        `,
      ],
      { cwd: process.cwd(), env: { ...process.env, AYA_HOME: dir } },
    );
    assert.deepEqual(JSON.parse(stdout), {
      version: 1,
      order: ["new"],
      open: [],
      recent: ["new"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
