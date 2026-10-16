import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readPtyPaneLimit } = require("../scripts/read-pty-pane-limit.cjs");
const { ptyOwnerBuildId } = require("../scripts/pty-owner-build-id.cjs");

test("owner build rejects a comment lookalike instead of selecting an ambiguous limit", () => {
  assert.throws(() => readPtyPaneLimit("/*\nexport const MAX_PTY_PANES = 256;\n*/\nexport const MAX_PTY_PANES = 128;\n"), /exactly one/);
  assert.throws(() => readPtyPaneLimit("export const MAX_PTY_PANES = 128;\nexport const MAX_PTY_PANES = 256;\n"), /exactly one/);
  assert.equal(readPtyPaneLimit("export const MAX_PTY_PANES = 128;\n"), 128);
  assert.throws(() => readPtyPaneLimit("export const MAX_PTY_PANES = 64 + 64;\n"), /exactly one/);
});

test("the native owner build ID changes when the shared pane limit changes", () => {
  const inputs = {
    platform: "linux",
    arch: "x64",
    flags: ["-DOWNER_MAX_PANES=128"],
    compilerVersion: "cc test version",
    paneLimitSource: "export const MAX_PTY_PANES = 128;\n",
    ownerSource: "owner",
    protocolSource: "protocol",
    identitySource: "identity",
  };
  const before = ptyOwnerBuildId(inputs);
  assert.notEqual(ptyOwnerBuildId({
    ...inputs,
    flags: ["-DOWNER_MAX_PANES=256"],
    paneLimitSource: "export const MAX_PTY_PANES = 256;\n",
  }), before);
});
