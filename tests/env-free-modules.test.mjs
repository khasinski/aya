// paths.ts reads AYA_HOME once, at load: a module a test or the pty host loads before setting it must not pull it in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const mod of ["launch-mode", "socket-path", "constants"]) {
  test(`${mod} loads without paths.ts, so it cannot freeze AYA_HOME early`, () => {
    const script = `require("./dist-electron/${mod}.js"); console.log(Object.keys(require.cache).some((f) => f.endsWith("/dist-electron/paths.js")))`;
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "false", r.stderr);
  });
}
