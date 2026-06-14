import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseLaunch,
  resolveHarnessAccount,
  scanWrapper,
} from "../dist-electron/harness-account.js";

test("parseLaunch: bare binary with args", () => {
  const r = parseLaunch("claude --dangerously-skip-permissions");
  assert.equal(r.binary, "claude");
  assert.deepEqual(r.env, {});
});

test("parseLaunch: inline env assignment before the binary", () => {
  const r = parseLaunch("CODEX_HOME=~/.codex2 codex --yolo");
  assert.equal(r.binary, "codex");
  assert.equal(r.env.CODEX_HOME, "~/.codex2");
});

test("parseLaunch: env prefix with -u flags and a quoted value", () => {
  const r = parseLaunch(
    'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" claude "$@"',
  );
  assert.equal(r.binary, "claude");
  assert.equal(r.env.CLAUDE_CONFIG_DIR, "$HOME/.claude-secondary");
});

test("parseLaunch: exec + env prefix", () => {
  const r = parseLaunch('exec env CODEX_HOME="$HOME/.codex2" codex "$@"');
  assert.equal(r.binary, "codex");
  assert.equal(r.env.CODEX_HOME, "$HOME/.codex2");
});

test("parseLaunch: a wrapper binary has no inline env", () => {
  const r = parseLaunch("claude2 --dangerously-skip-permissions");
  assert.equal(r.binary, "claude2");
  assert.deepEqual(r.env, {});
});

test("scanWrapper: zsh function body for a second Claude account", () => {
  const body =
    'claude2 () {\n\tenv -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" claude "$@"\n}';
  const r = scanWrapper(body);
  assert.equal(r.harness, "claude");
  assert.equal(r.env.CLAUDE_CONFIG_DIR, "$HOME/.claude-secondary");
});

test("scanWrapper: wrapper script for a second Codex account", () => {
  const txt = '#!/bin/zsh\nexec env CODEX_HOME="$HOME/.codex2" codex "$@"\n';
  const r = scanWrapper(txt);
  assert.equal(r.harness, "codex");
  assert.equal(r.env.CODEX_HOME, "$HOME/.codex2");
});

test("scanWrapper: \\bclaude\\b does not match claude2", () => {
  const r = scanWrapper("run claude2 here");
  // "claude2" must not be read as the claude binary.
  assert.notEqual(r.harness, "claude");
});

test("scanWrapper: non-agent text yields no harness", () => {
  const r = scanWrapper("htop");
  assert.equal(r.harness, null);
  assert.deepEqual(r.env, {});
});

test("resolveHarnessAccount: bare claude binary resolves to the default config dir", async () => {
  const acc = await resolveHarnessAccount("claude");
  assert.equal(acc?.harness, "claude");
  assert.equal(acc?.configDir, path.join(os.homedir(), ".claude"));
});

test("resolveHarnessAccount: bare codex binary resolves to the default home", async () => {
  const acc = await resolveHarnessAccount("codex");
  assert.equal(acc?.harness, "codex");
  assert.equal(acc?.configDir, path.join(os.homedir(), ".codex"));
});

test("resolveHarnessAccount: inline env overrides the config dir for the direct binary", async () => {
  const acc = await resolveHarnessAccount(
    'env CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" claude --foo',
  );
  assert.equal(acc?.harness, "claude");
  assert.equal(
    acc?.configDir,
    path.join(os.homedir(), ".claude-secondary"),
  );
});

test("resolveHarnessAccount: ~ in the env value expands to HOME", async () => {
  const acc = await resolveHarnessAccount("CODEX_HOME=~/.codex2 codex");
  assert.equal(acc?.harness, "codex");
  assert.equal(acc?.configDir, path.join(os.homedir(), ".codex2"));
});

test("resolveHarnessAccount: non-agent binary returns null without spawning a shell", async () => {
  // A made-up binary name with no inline env: there's no harness to detect and
  // the wrapper-resolution path early-exits on the name being a safe identifier
  // that the shell never resolves. The test just must not hang.
  const acc = await resolveHarnessAccount("definitely_not_a_harness_xyz");
  assert.equal(acc, null);
});

test("resolveHarnessAccount: empty command returns null", async () => {
  assert.equal(await resolveHarnessAccount(""), null);
});
