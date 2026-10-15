import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
test("native owner boundary includes only its protocol and process identity, without JS or agent dependencies", () => {
  const root = path.resolve("electron/native/pty-owner"), source = fs.readFileSync(path.join(root, "owner.c"), "utf8");
  assert.deepEqual([...source.matchAll(/^#include "([^"]+)"/gm)].map(m => m[1]).sort(), ["process-identity.h", "protocol.h"]);
  for (const name of ["owner.c", "process-identity.h", "protocol.h"]) {
    const text = fs.readFileSync(path.join(root, name), "utf8");
    assert.doesNotMatch(text, /node_api|xterm|agent-screen|agent-session|agent-brief|usage-codex|codex-daemon|launch-config|pane-env/);
  }
});
