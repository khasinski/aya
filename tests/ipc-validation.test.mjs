// Runtime validation for renderer -> main IPC payloads. TypeScript covers the
// happy path, but malformed IPC messages still arrive as unknown at runtime.

import { MAX_SPLIT_ROWS, MAX_SPLIT_COLS } from "../dist-electron/validation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireString,
  requireStringArray,
  validatePresetArray,
  validateProjectCollectionState,
  validateProjectConfig,
  validateSpawnRequest,
  validateThemesFile,
} from "../dist-electron/validation.js";
import { AYA_DARK } from "../dist-electron/themes.js";

test("validateSpawnRequest accepts the pty spawn shape", () => {
  assert.deepEqual(
    validateSpawnRequest({
      ptyId: "abc",
      projectSlug: "aya",
      presetId: "codex",
      command: "claude",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    }),
    {
      ptyId: "abc",
      projectSlug: "aya",
      presetId: "codex",
      command: "claude",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    },
  );
});

test("validateSpawnRequest passes the attach flags through (regression: they were silently dropped)", () => {
  // The validator REBUILDS the request object, so a field it does not copy
  // dies at the IPC boundary. attachOnly shipped after the validator and was
  // never added: the renderer sent it, the host never saw it, and dead-PTY
  // re-mounts silently respawned fresh processes - while the host-side unit
  // tests (which bypass the validator) stayed green. These pins make that
  // class of regression loud.
  const base = { ptyId: "abc", command: "claude", cwd: "/tmp", cols: 80, rows: 24 };
  assert.equal(validateSpawnRequest({ ...base, attachOnly: true }).attachOnly, true);
  assert.equal(
    validateSpawnRequest({ ...base, attachIfReused: true }).attachIfReused,
    true,
  );
  // Absent or false flags stay off the wire (undefined, not false).
  assert.equal(validateSpawnRequest(base).attachOnly, undefined);
  assert.equal(validateSpawnRequest({ ...base, attachOnly: false }).attachOnly, undefined);
  // A truthy non-boolean must not act as a flag.
  assert.throws(
    () => validateSpawnRequest({ ...base, attachOnly: "yes" }),
    /pty:spawn\.attachOnly/,
  );
  assert.throws(
    () => validateSpawnRequest({ ...base, attachIfReused: 1 }),
    /pty:spawn\.attachIfReused/,
  );
});

test("validateSpawnRequest rejects missing or invalid dimensions", () => {
  assert.throws(
    () =>
      validateSpawnRequest({
        ptyId: "abc",
        command: "claude",
        cwd: "/tmp",
        cols: 0,
        rows: 24,
      }),
    /pty:spawn\.cols/,
  );
  assert.throws(() => validateSpawnRequest(null), /pty:spawn/);
});

test("validateProjectConfig accepts project tabs and rejects bad tab shapes", () => {
  const project = validateProjectConfig({
    slug: "aya",
    name: "Aya",
    directory: "/tmp/aya",
    tabs: [{ id: "t1", presetId: "shell", name: "Shell" }],
    splitLayout: {
      rows: 1,
      cols: 2,
      rowFr: [1],
      colFr: [1, 2],
      cells: ["t1", null],
      activeCell: 0,
    },
  });
  assert.equal(project.tabs[0].presetId, "shell");
  assert.deepEqual(project.splitLayout?.colFr, [1, 2]);

  assert.throws(
    () =>
      validateProjectConfig({
        slug: "aya",
        name: "Aya",
        directory: "/tmp/aya",
        tabs: [{ id: "t1", presetId: "shell" }],
      }),
    /tabs\[0\]\.name/,
  );
});

test("validateProjectConfig rejects invalid split layout payloads", () => {
  const base = {
    slug: "aya",
    name: "Aya",
    directory: "/tmp/aya",
    tabs: [{ id: "t1", presetId: "shell", name: "Shell" }],
  };
  assert.throws(
    () =>
      validateProjectConfig({
        ...base,
        splitLayout: {
          rows: MAX_SPLIT_ROWS + 1,
          cols: 1,
          rowFr: [1],
          colFr: [1],
          cells: ["t1"],
          activeCell: 0,
        },
      }),
    /splitLayout\.rows/,
  );
  assert.throws(
    () =>
      validateProjectConfig({
        ...base,
        splitLayout: {
          rows: 1,
          cols: 2,
          rowFr: [1],
          colFr: [1, 1],
          cells: ["t1", 42],
          activeCell: 0,
        },
      }),
    /splitLayout\.cells/,
  );
  assert.throws(
    () =>
      validateProjectConfig({
        ...base,
        splitLayout: {
          rows: 1,
          cols: 2,
          rowFr: [1],
          colFr: [1, -1],
          cells: ["t1", null],
          activeCell: 0,
        },
      }),
    /splitLayout\.colFr/,
  );
});

test("validateProjectConfig accepts a max 5x5 split but rejects one beyond max", () => {
  const base = {
    slug: "aya",
    name: "Aya",
    directory: "/tmp/aya",
    tabs: [{ id: "t1", presetId: "shell", name: "Shell" }],
  };
  // A layout at the split-grid maximum (5 rows x 5 cols) validates OK.
  const atMax = validateProjectConfig({
    ...base,
    splitLayout: {
      rows: MAX_SPLIT_ROWS,
      cols: MAX_SPLIT_COLS,
      rowFr: [1, 1, 1, 1, 1],
      colFr: [1, 1, 1, 1, 1],
      cells: ["t1"],
      activeCell: 0,
    },
  });
  assert.equal(atMax.splitLayout?.rows, MAX_SPLIT_ROWS);
  assert.equal(atMax.splitLayout?.cols, MAX_SPLIT_COLS);

  // One row beyond the maximum is rejected.
  assert.throws(
    () =>
      validateProjectConfig({
        ...base,
        splitLayout: {
          rows: MAX_SPLIT_ROWS + 1,
          cols: MAX_SPLIT_COLS,
          rowFr: [1],
          colFr: [1],
          cells: ["t1"],
          activeCell: 0,
        },
      }),
    /splitLayout\.rows/,
  );

  // One col beyond the maximum is rejected.
  assert.throws(
    () =>
      validateProjectConfig({
        ...base,
        splitLayout: {
          rows: MAX_SPLIT_ROWS,
          cols: MAX_SPLIT_COLS + 1,
          rowFr: [1],
          colFr: [1],
          cells: ["t1"],
          activeCell: 0,
        },
      }),
    /splitLayout\.cols/,
  );
});

test("validateProjectCollectionState accepts order/open/recent arrays", () => {
  // Active-selection fields are optional; when absent they default to empty so
  // the IPC boundary always emits the full schema (back-compat with old files).
  assert.deepEqual(
    validateProjectCollectionState({
      version: 1,
      order: ["a", "b"],
      open: ["a"],
      recent: ["b", "a"],
    }),
    {
      version: 1,
      order: ["a", "b"],
      open: ["a"],
      recent: ["b", "a"],
      activeProject: null,
      activeTab: {},
      singleView: {},
    },
  );
  assert.throws(
    () =>
      validateProjectCollectionState({
        version: 1,
        order: ["a"],
        open: [42],
        recent: [],
      }),
    /projects:save-state\.open/,
  );
});

test("validateProjectCollectionState passes active selections through (not dropped)", () => {
  // Regression guard for #18: the IPC validator used to hand-build a
  // {version,order,open,recent} subset, silently dropping the active terminal /
  // project / view — so the renderer's restored selection never reached disk.
  assert.deepEqual(
    validateProjectCollectionState({
      version: 1,
      order: ["a"],
      open: ["a"],
      recent: ["a"],
      activeProject: "a",
      activeTab: { a: "tab-2" },
      singleView: { a: "tab-2" },
    }),
    {
      version: 1,
      order: ["a"],
      open: ["a"],
      recent: ["a"],
      activeProject: "a",
      activeTab: { a: "tab-2" },
      singleView: { a: "tab-2" },
    },
  );
});

test("validateProjectCollectionState sanitizes malformed active fields leniently", () => {
  // A malformed active entry must never block a save — it is coerced, not
  // rejected (the renderer owns these fields and re-derives them on boot).
  assert.deepEqual(
    validateProjectCollectionState({
      version: 1,
      order: ["a"],
      open: ["a"],
      recent: ["a"],
      activeProject: 42,
      activeTab: { a: "tab-1", b: 99, c: null },
      singleView: "not-an-object",
    }),
    {
      version: 1,
      order: ["a"],
      open: ["a"],
      recent: ["a"],
      activeProject: null,
      activeTab: { a: "tab-1" },
      singleView: {},
    },
  );
});

test("primitive validators reject cross-type payloads", () => {
  assert.equal(requireString("ok", "field"), "ok");
  assert.deepEqual(requireStringArray(["a", "b"], "list"), ["a", "b"]);
  assert.throws(() => requireString(42, "field"), /field/);
  assert.throws(() => requireStringArray(["a", 2], "list"), /list/);
});

test("validatePresetArray rejects malformed preset entries", () => {
  const presets = validatePresetArray([
    {
      id: "codex",
      name: "Codex",
      icon: "◆",
      color: "#10a37f",
      command: "codex",
      agent: "codex",
      configDir: "~/.codex-work",
      autoResume: true,
    },
  ]);
  assert.equal(presets[0].command, "codex");
  assert.equal(presets[0].agent, "codex");
  assert.equal(presets[0].configDir, "~/.codex-work");
  assert.equal(presets[0].autoResume, true);

  assert.throws(
    () =>
      validatePresetArray([
        {
          id: "broken",
          name: "Broken",
          icon: "?",
          color: "",
        },
      ]),
    /presets:save\[0\]/,
  );
});

test("validateThemesFile checks nested theme color shape", () => {
  const valid = validateThemesFile({
    themes: [AYA_DARK],
    activeId: AYA_DARK.id,
  });
  assert.equal(valid.themes[0].colors.background, "#0d1117");

  assert.throws(
    () =>
      validateThemesFile({
        themes: [
          {
            ...AYA_DARK,
            colors: { ...AYA_DARK.colors, brightWhite: 42 },
          },
        ],
        activeId: AYA_DARK.id,
      }),
    /themes:save\.themes\[0\]\.colors\.brightWhite/,
  );
});

test("split-grid maximum is pinned (boundary tests above derive from it)", () => {
  assert.equal(MAX_SPLIT_ROWS, 5);
  assert.equal(MAX_SPLIT_COLS, 5);
});

// --- WorkingTab optional fields must SURVIVE the boundary -------------------
// Regression: this validator rebuilt the tab field-by-field and silently
// dropped `cwd` and `sessionId`. Everything upstream looked correct — the
// renderer sent them, tabFromTerminal produced them — but a worktree tab
// reverted to the project directory on restart and `--resume <id>` quietly
// degraded to "resume whatever was latest". Nothing failed loudly.

test("validateProjectConfig preserves a tab's worktree cwd", () => {
  const project = validateProjectConfig({
    slug: "aya",
    name: "Aya",
    directory: "/tmp/aya",
    tabs: [
      { id: "t1", presetId: "claude", name: "Claude", cwd: "/tmp/aya-wt/feat" },
    ],
  });
  assert.equal(project.tabs[0].cwd, "/tmp/aya-wt/feat");
});

test("validateProjectConfig preserves a tab's agent session id", () => {
  const project = validateProjectConfig({
    slug: "aya",
    name: "Aya",
    directory: "/tmp/aya",
    tabs: [
      { id: "t1", presetId: "claude", name: "Claude", sessionId: "sess-abc.123" },
    ],
  });
  assert.equal(project.tabs[0].sessionId, "sess-abc.123");
});

test("a tab without cwd/sessionId keeps them absent, not undefined-valued", () => {
  const project = validateProjectConfig({
    slug: "aya",
    name: "Aya",
    directory: "/tmp/aya",
    tabs: [{ id: "t1", presetId: "shell", name: "Shell" }],
  });
  assert.equal("cwd" in project.tabs[0], false);
  assert.equal("sessionId" in project.tabs[0], false);
});

test("a session id that could alter a command line is rejected at the boundary", () => {
  // The id ends up inside a spawn command on restore, so the IPC layer
  // re-checks it rather than trusting the renderer.
  for (const sessionId of ["bad; rm -rf /", "a b", "$(whoami)", "`id`", "x".repeat(201)]) {
    assert.throws(
      () =>
        validateProjectConfig({
          slug: "aya",
          name: "Aya",
          directory: "/tmp/aya",
          tabs: [{ id: "t1", presetId: "claude", name: "C", sessionId }],
        }),
      /sessionId/,
      `should reject: ${JSON.stringify(sessionId)}`,
    );
  }
});
