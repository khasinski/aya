// Runtime validation for renderer -> main IPC payloads. TypeScript covers the
// happy path, but malformed IPC messages still arrive as unknown at runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireString,
  requireStringArray,
  validatePresetArray,
  validateProjectConfig,
  validateSpawnRequest,
  validateThemesFile,
} from "../dist-electron/validation.js";
import { AYA_DARK } from "../dist-electron/themes.js";

test("validateSpawnRequest accepts the pty spawn shape", () => {
  assert.deepEqual(
    validateSpawnRequest({
      ptyId: "abc",
      command: "claude",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    }),
    {
      ptyId: "abc",
      command: "claude",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    },
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
  });
  assert.equal(project.tabs[0].presetId, "shell");

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
    },
  ]);
  assert.equal(presets[0].command, "codex");

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
