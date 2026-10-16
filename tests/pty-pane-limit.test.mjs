import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readPtyPaneLimit } = require("../scripts/read-pty-pane-limit.cjs");

test("owner build reads only the unique exported literal, not a comment lookalike", () => {
  assert.equal(readPtyPaneLimit("/**\n * export const MAX_PTY_PANES = 256;\n */\nexport const MAX_PTY_PANES = 128;\n"), 128);
  assert.throws(() => readPtyPaneLimit("export const MAX_PTY_PANES = 128;\nexport const MAX_PTY_PANES = 256;\n"), /exactly one/);
  assert.throws(() => readPtyPaneLimit("export const MAX_PTY_PANES = 64 + 64;\n"), /integer literal/);
});
