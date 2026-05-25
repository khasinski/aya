// Guards the shipped DEFAULT_PRESETS against accidentally launching Claude /
// Codex in non-interactive (API-billed) mode. If this test ever fails, the
// Claude subscription license guarantee in CLAUDE.md is at risk.
//
// User-defined presets are not covered — they're the user's own configuration.
// The Settings UI shows an inline warning when a custom command looks
// non-interactive, but doesn't block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRESETS } from "../dist-electron/presets.js";
import { bashArgv } from "../dist-electron/pty.js";

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

test("bashArgv wraps the user command in /bin/bash -lc + cd + exec", () => {
  const argv = bashArgv("claude", "/tmp/aya-test");
  assert.equal(argv[0], "/bin/bash");
  assert.equal(argv[1], "-lc");
  assert.match(argv[2], /^cd '\/tmp\/aya-test' && exec claude$/);
});

test("bashArgv shell-quotes the cwd so spaces and quotes don't break", () => {
  const argv = bashArgv("claude", "/tmp/with 'tricky' name");
  assert.match(argv[2], /cd '\/tmp\/with '\\''tricky'\\'' name'/);
});

test("bashArgv passes the command verbatim so $VARS expand", () => {
  // The shell preset uses literal $SHELL; we count on bash -lc to expand it.
  // Therefore the command must NOT be single-quoted by bashArgv.
  const argv = bashArgv("$SHELL", "/tmp");
  assert.ok(
    argv[2].endsWith("exec $SHELL"),
    `expected unquoted $SHELL in argv: ${argv[2]}`,
  );
});
