// The pty host is stale when any module it runs changed, not only its entry
// script: a change in vt-state went unnoticed until a full restart (2026-09-28).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostBuildHash, hostModuleFiles } from "../dist-electron/pty-host-staleness.js";

function build(files) {
  const dir = mkdtempSync(join(tmpdir(), "aya-host-hash-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("the host's modules are what its entry script requires, followed through", () => {
  const dir = build({
    "host.js": 'require("./a"); const x = require("./b"); require("node:fs"); require("some-package");',
    "a.js": 'require("./c");',
    "b.js": 'require("./a");',
    "c.js": "",
    "unrelated.js": 'require("./a");',
  });
  try {
    assert.deepEqual(hostModuleFiles(dir, "host.js"), ["a.js", "b.js", "c.js", "host.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a change in a required module changes the hash; a change elsewhere does not", () => {
  const dir = build({ "host.js": 'require("./a");', "a.js": 'require("./c");', "c.js": "1", "main.js": "1" });
  try {
    const before = hostBuildHash(dir, "host.js");
    writeFileSync(join(dir, "main.js"), "2");
    assert.equal(hostBuildHash(dir, "host.js"), before);
    writeFileSync(join(dir, "c.js"), "2");
    assert.notEqual(hostBuildHash(dir, "host.js"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real host requires vt-state and the screen rules", async () => {
  const files = hostModuleFiles(new URL("../dist-electron", import.meta.url).pathname, "pty-host.js");
  for (const f of ["pty-host.js", "pty.js", "vt-state.js", "agent-screen-rules.js", "pane-command.js"]) assert.ok(files.includes(f), f);
  assert.ok(!files.includes("main.js"));
});
