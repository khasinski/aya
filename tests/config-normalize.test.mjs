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
import { normalizeSplitLayout, normalizeTab } from "../dist-electron/config.js";

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

test("normalizes split layout and drops unknown terminal ids", () => {
  const out = normalizeSplitLayout(
    {
      rows: 2,
      cols: 3,
      rowFr: [2, 1],
      colFr: [1, 2, 1],
      cells: ["a", "missing", null, "b"],
      activeCell: 4,
    },
    new Set(["a", "b"]),
  );
  assert.deepEqual(out, {
    rows: 2,
    cols: 3,
    rowFr: [2, 1],
    colFr: [1, 2, 1],
    cells: ["a", null, null, "b", null, null],
    activeCell: 4,
  });
});

test("normalizes split layout dimensions, tracks, cells, and active cell", () => {
  const out = normalizeSplitLayout(
    {
      rows: 9,
      cols: 0,
      rowFr: [2, -1, 0, Number.NaN, 3, 4],
      colFr: ["bad"],
      cells: ["a"],
      activeCell: 999,
    },
    new Set(["a"]),
  );
  assert.deepEqual(out, {
    rows: 5,
    cols: 1,
    rowFr: [2, 3, 4, 1, 1],
    colFr: [1],
    cells: ["a", null, null, null, null],
    activeCell: 4,
  });
});

test("split layout removes duplicate terminal assignments", () => {
  const out = normalizeSplitLayout(
    {
      rows: 2,
      cols: 2,
      rowFr: [1, 1],
      colFr: [1, 1],
      cells: ["a", "a", "b", "b"],
      activeCell: 0,
    },
    new Set(["a", "b"]),
  );
  assert.deepEqual(out?.cells, ["a", null, "b", null]);
});

test("split layout pads missing track sizes and cells", () => {
  const out = normalizeSplitLayout(
    {
      rows: 2,
      cols: 3,
      rowFr: [3],
      colFr: [2],
      cells: ["a"],
      activeCell: -10,
    },
    new Set(["a"]),
  );
  assert.deepEqual(out, {
    rows: 2,
    cols: 3,
    rowFr: [3, 1],
    colFr: [2, 1, 1],
    cells: ["a", null, null, null, null, null],
    activeCell: 0,
  });
});

test("split layout with no live terminals compacts away", () => {
  const out = normalizeSplitLayout(
    {
      rows: 2,
      cols: 2,
      rowFr: [1, 1],
      colFr: [1, 1],
      cells: ["missing"],
      activeCell: 0,
    },
    new Set(["a"]),
  );
  assert.equal(out, undefined);
});

test("single-cell split layout compacts away", () => {
  const out = normalizeSplitLayout(
    {
      rows: 1,
      cols: 1,
      rowFr: [1],
      colFr: [1],
      cells: ["a"],
      activeCell: 0,
    },
    new Set(["a"]),
  );
  assert.equal(out, undefined);
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
    // The in-memory migrated value carries only the legacy fields.
    assert.deepEqual(state, {
      version: 1,
      order: ["a", "b"],
      open: ["b"],
      recent: ["a", "b"],
    });
    // On disk it is round-tripped through the normalizer, so it always carries
    // the full schema (active fields default to empty) — single source of truth
    // for read and write (#18).
    assert.deepEqual(persisted, {
      version: 1,
      order: ["a", "b"],
      open: ["b"],
      recent: ["a", "b"],
      activeProject: null,
      activeTab: {},
      singleView: {},
    });
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
      activeProject: null,
      activeTab: {},
      singleView: {},
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
