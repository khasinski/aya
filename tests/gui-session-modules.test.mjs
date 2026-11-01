// The GUI session modules must not form a runtime import cycle: in a cycle the
// load order decides whether a value is defined yet, and a later edit (a re-export
// moved up, a top-level use) can turn a shared tool into undefined without an error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const dist = (name) => new URL(`../dist-electron/${name}.js`, import.meta.url);
const runtimeRequires = (name) =>
  [...readFileSync(dist(name), "utf8").matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);

test("multi-agent-gui-session does not load codex-gui-session at runtime", () => {
  assert.equal(runtimeRequires("multi-agent-gui-session").includes("codex-gui-session"), false);
});

test("the shared artifact tools live in a module that loads neither session", () => {
  const deps = runtimeRequires("gui-artifact-tools");
  assert.equal(deps.includes("codex-gui-session"), false);
  assert.equal(deps.includes("multi-agent-gui-session"), false);
});

for (const first of ["codex-gui-session", "multi-agent-gui-session"]) {
  test(`loading ${first} first defines every shared export`, () => {
    const require = createRequire(import.meta.url);
    for (const key of Object.keys(require.cache)) {
      if (key.includes("gui-session") || key.includes("gui-artifact-tools")) delete require.cache[key];
    }
    require(dist(first).pathname);
    const codex = require(dist("codex-gui-session").pathname);
    const multi = require(dist("multi-agent-gui-session").pathname);
    assert.equal(typeof codex.PRESENT_TOOL, "object");
    assert.equal(typeof codex.OPEN_ARTIFACT_TOOL, "object");
    assert.equal(typeof codex.presentArtifact, "function");
    assert.equal(typeof codex.workspaceImage, "function");
    assert.equal(typeof codex.PiGuiSession, "function");
    assert.equal(typeof multi.presentArtifact, "function");
    assert.equal(typeof multi.workspaceImage, "function");
  });
}
