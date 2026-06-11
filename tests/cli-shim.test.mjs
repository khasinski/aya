// The installed `aya` shim must survive Aya.app being moved or renamed
// (maintainer follow-up on #42): it tries the baked path, falls back to the
// default install location, and otherwise fails with a message that points at
// the repair path (Settings -> Reinstall) instead of sh's cryptic
// "No such file or directory".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseShimTargets,
  renderCliShim,
} from "../dist-electron/cli-shim.js";

const PRIMARY = "/Users/dev/build/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya";
const FALLBACK = "/Applications/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya";

test("shim tries the baked path first and execs it", () => {
  const s = renderCliShim(PRIMARY, FALLBACK);
  assert.ok(s.startsWith("#!/bin/sh\n"));
  assert.ok(s.includes(JSON.stringify(PRIMARY)));
  assert.ok(s.includes('exec "$AYA_CLI"'));
});

test("shim falls back to the default install location when the baked path died", () => {
  const s = renderCliShim(PRIMARY, FALLBACK);
  assert.ok(s.includes(JSON.stringify(FALLBACK)));
  // fallback only engages when the primary is not executable
  assert.ok(/if \[ ! -x "\$AYA_CLI" \]/.test(s));
});

test("no fallback block when none is available (non-mac or same path)", () => {
  const s = renderCliShim(PRIMARY, null);
  assert.equal(s.includes("moved"), true); // error path still present
  assert.equal((s.match(/AYA_CLI=/g) ?? []).length, 1);
});

test("when nothing resolves, the shim names the repair path and exits 127", () => {
  const s = renderCliShim(PRIMARY, FALLBACK);
  assert.ok(s.includes("Settings"));
  assert.ok(s.toLowerCase().includes("reinstall"));
  assert.ok(s.includes("exit 127"));
});

test("parseShimTargets round-trips the generated shim", () => {
  assert.deepEqual(parseShimTargets(renderCliShim(PRIMARY, FALLBACK)), [
    PRIMARY,
    FALLBACK,
  ]);
  assert.deepEqual(parseShimTargets(renderCliShim(PRIMARY, null)), [PRIMARY]);
});

test("parseShimTargets understands the legacy #42 shim format", () => {
  const legacy = `#!/bin/sh\nexec ${JSON.stringify(FALLBACK)} "$@"\n`;
  assert.deepEqual(parseShimTargets(legacy), [FALLBACK]);
});

test("parseShimTargets returns [] for scripts that are not our shim", () => {
  assert.deepEqual(parseShimTargets("#!/bin/bash\necho hello\n"), []);
  assert.deepEqual(parseShimTargets(""), []);
});
