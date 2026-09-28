// A pane whose command is a plain shell never takes team messages: Enter
// would run the text as a command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isShellCommand } from "../dist-electron/pty.js";

test("plain shells are shells; agents and shell-wrapped agents are not", () => {
  for (const c of ["$SHELL", "zsh", "/bin/bash -l", "fish", "sh"]) assert.equal(isShellCommand(c), true, c);
  for (const c of ["claude", "codex --yolo", 'CLAUDE_CONFIG_DIR="$HOME/x" claude', "bash -c 'claude'", "node agent.cjs"]) {
    assert.equal(isShellCommand(c), false, c);
  }
});

test("a shell with flags is still a shell", () => {
  for (const c of ["zsh -i", "bash -l -i", "/bin/zsh -il"]) assert.equal(isShellCommand(c), true, c);
});
