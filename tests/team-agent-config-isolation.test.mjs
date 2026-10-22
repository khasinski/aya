import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveClaudeConfigDir } = require("../e2e/helpers/claude-config-dir.cjs");

test("fake Claude uses an explicit config directory when provided", () => {
  assert.equal(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/isolated/claude" }, "/home/user"), "/isolated/claude");
});

test("fake Claude derives its config directory only from an isolated home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aya-agent-home-"));
  try {
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    assert.equal(resolveClaudeConfigDir({ HOME: home }, path.join(root, "real-home")), path.join(home, ".claude"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake Claude refuses an unset or real home without an explicit config directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aya-agent-home-"));
  try {
    const realHome = path.join(root, "real-home");
    fs.mkdirSync(realHome);
    assert.throws(() => resolveClaudeConfigDir({}, realHome), /isolated home or CLAUDE_CONFIG_DIR/);
    assert.throws(() => resolveClaudeConfigDir({ HOME: realHome }, realHome), /isolated home or CLAUDE_CONFIG_DIR/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
