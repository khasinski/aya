// Guards the shipped DEFAULT_PRESETS against accidentally launching Claude /
// Codex in non-interactive (API-billed) mode. If this test ever fails, the
// Claude subscription license guarantee in CLAUDE.md is at risk.
//
// User-defined presets are not covered — they're the user's own configuration.
// The Settings UI shows an inline warning when a custom command looks
// non-interactive, but doesn't block.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { DEFAULT_PRESETS } from "../dist-electron/presets.js";
import { shellArgv } from "../dist-electron/pty.js";

const FORBIDDEN = [
  /(?<!\w)-p(?!\w)/,
  /--print(?!\w)/,
  /--headless(?!\w)/,
  /--non-interactive(?!\w)/,
  /--no-interactive(?!\w)/,
];

for (const preset of DEFAULT_PRESETS) {
  test(`default preset "${preset.id}" command is interactive`, () => {
    for (const re of FORBIDDEN) {
      assert.ok(
        !re.test(preset.command),
        `${preset.id} contains forbidden flag ${re}: ${preset.command}`,
      );
    }
  });
}

test("default claude/codex use bare commands (no flags)", () => {
  for (const id of ["claude", "codex"]) {
    const p = DEFAULT_PRESETS.find((x) => x.id === id);
    assert.ok(p, `default preset ${id} missing`);
    // Exact-string check: defaults are the bare command. Users can edit.
    assert.equal(p.command, id);
  }
});

test("default shell preset stays user-facing simple", () => {
  const p = DEFAULT_PRESETS.find((x) => x.id === "shell");
  assert.ok(p, "default shell preset missing");
  assert.equal(p.command, "$SHELL");
  assert.doesNotMatch(p.command, /env|EDITOR|VISUAL|exec/);
});

test("shellArgv wraps the user command in $SHELL -l -i -c + cd + exec", () => {
  // Force a known SHELL so the assertion is deterministic in CI.
  const before = process.env.SHELL;
  process.env.SHELL = "/bin/zsh";
  try {
    const argv = shellArgv("claude", "/tmp/aya-test");
    assert.equal(argv[0], "/bin/zsh");
    assert.equal(argv[1], "-l");
    assert.equal(argv[2], "-i");
    assert.equal(argv[3], "-c");
    assert.match(argv[4], /^cd '\/tmp\/aya-test' && exec claude$/);
  } finally {
    if (before === undefined) delete process.env.SHELL;
    else process.env.SHELL = before;
  }
});

test("shellArgv falls back to the account login shell when SHELL is unset", () => {
  const before = process.env.SHELL;
  delete process.env.SHELL;
  try {
    const argv = shellArgv("claude", "/tmp/aya-test");
    assert.equal(argv[0], os.userInfo().shell || "/bin/bash");
  } finally {
    if (before !== undefined) process.env.SHELL = before;
  }
});

test("shellArgv shell-quotes the cwd so spaces and quotes don't break", () => {
  const argv = shellArgv("claude", "/tmp/with 'tricky' name");
  assert.match(argv[4], /cd '\/tmp\/with '\\''tricky'\\'' name'/);
});

test("shellArgv passes the command verbatim so $VARS expand", () => {
  // The shell preset uses literal $SHELL; we count on the wrapping shell's
  // -l -c to expand it. Therefore the command must NOT be single-quoted by
  // shellArgv.
  const argv = shellArgv("$SHELL", "/tmp");
  assert.ok(
    argv[4].endsWith("exec env -u EDITOR -u VISUAL $SHELL"),
    `expected unquoted $SHELL in argv: ${argv[4]}`,
  );
});

test("shellArgv unsets editor vars only for the nested shell launcher", () => {
  const shell = shellArgv("$SHELL", "/tmp");
  assert.match(shell[4], /exec env -u EDITOR -u VISUAL \$SHELL$/);

  const agent = shellArgv("claude", "/tmp");
  assert.match(agent[4], /exec claude$/);
  assert.doesNotMatch(agent[4], /EDITOR|VISUAL/);
});

test("shellArgv puts exec after leading env assignments", () => {
  const argv = shellArgv("CLAUDE_CONFIG_DIR=/tmp/claude-secondary claude", "/tmp");
  assert.ok(
    argv[4].endsWith("CLAUDE_CONFIG_DIR=/tmp/claude-secondary exec claude"),
    `expected exec after env assignment: ${argv[4]}`,
  );
});

test("shellArgv keeps quoted env assignment values intact", () => {
  const argv = shellArgv('CODEX_HOME="$HOME/.codex work" codex', "/tmp");
  assert.ok(
    argv[4].endsWith('CODEX_HOME="$HOME/.codex work" exec codex'),
    `expected quoted assignment before exec: ${argv[4]}`,
  );
});
