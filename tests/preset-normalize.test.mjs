// Preset normalization (roundtrip, optional themeId, malformed input).

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePreset, isPreset, DEFAULT_PRESETS } from "../dist-electron/presets.js";

test("accepts a well-formed preset", () => {
  const p = normalizePreset({
    id: "aider",
    name: "Aider",
    icon: "A",
    color: "#f0ad4e",
    command: "aider --dark",
  });
  assert.deepEqual(p, {
    id: "aider",
    name: "Aider",
    icon: "A",
    color: "#f0ad4e",
    command: "aider --dark",
  });
  // Optional themeId omitted entirely (not undefined-on-key).
  assert.equal(Object.prototype.hasOwnProperty.call(p, "themeId"), false);
});

test("preserves a non-empty themeId", () => {
  const p = normalizePreset({
    id: "claude",
    name: "Claude",
    icon: "✻",
    color: "",
    command: "claude",
    themeId: "tokyo-night",
  });
  assert.equal(p.themeId, "tokyo-night");
});

test("treats empty-string themeId as 'use default'", () => {
  const p = normalizePreset({
    id: "claude",
    name: "Claude",
    icon: "✻",
    color: "",
    command: "claude",
    themeId: "",
  });
  // Empty string is dropped so the field is absent rather than present-empty.
  assert.equal(Object.prototype.hasOwnProperty.call(p, "themeId"), false);
});

test("preserves agent account metadata", () => {
  const p = normalizePreset({
    id: "claude-work",
    name: "Claude Work",
    icon: "✻",
    color: "#d97757",
    command: 'CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude',
    agent: "claude",
    configDir: "~/.claude-work",
    unsafeMode: true,
    autoResume: true,
  });
  assert.deepEqual(p, {
    id: "claude-work",
    name: "Claude Work",
    icon: "✻",
    color: "#d97757",
    command: 'CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude',
    agent: "claude",
    configDir: "~/.claude-work",
    unsafeMode: true,
    autoResume: true,
  });
});

test("drops falsey agent metadata flags and empty configDir", () => {
  const p = normalizePreset({
    id: "codex",
    name: "Codex",
    icon: "◆",
    color: "#10a37f",
    command: "codex",
    agent: "codex",
    configDir: "",
    unsafeMode: false,
    autoResume: false,
  });
  assert.equal(p?.agent, "codex");
  assert.equal(Object.prototype.hasOwnProperty.call(p, "configDir"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, "unsafeMode"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, "autoResume"), false);
});

test("rejects bad shapes", () => {
  assert.equal(normalizePreset(null), null);
  assert.equal(normalizePreset(undefined), null);
  assert.equal(normalizePreset("string"), null);
  assert.equal(normalizePreset({}), null);
  assert.equal(normalizePreset({ id: "a" }), null);
  assert.equal(
    normalizePreset({
      id: "a",
      name: "A",
      icon: "x",
      color: "",
      command: "x",
      themeId: 42, // wrong type
    }),
    null,
  );
  assert.equal(
    normalizePreset({
      id: "a",
      name: "A",
      icon: "x",
      color: "",
      command: "x",
      agent: "other",
    }),
    null,
  );
  assert.equal(
    normalizePreset({
      id: "a",
      name: "A",
      icon: "x",
      color: "",
      command: "x",
      autoResume: "yes",
    }),
    null,
  );
});

test("isPreset agrees with normalizePreset on shipped defaults", () => {
  for (const p of DEFAULT_PRESETS) {
    assert.ok(isPreset(p), `default preset ${p.id} should pass isPreset`);
    const n = normalizePreset(p);
    assert.equal(n?.id, p.id);
    assert.equal(n?.command, p.command);
  }
});
