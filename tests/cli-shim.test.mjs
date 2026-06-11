// The installed `aya` shim must survive Aya.app being moved or renamed
// (maintainer follow-up on #42): it tries the baked path, falls back to the
// default install location, and otherwise fails with a message that points at
// the repair path (Settings -> Reinstall) instead of sh's cryptic
// "No such file or directory".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultInstallAyaCliPath,
  parseShimTargets,
  renderCliShim,
} from "../dist-electron/cli-shim.js";

const PRIMARY = "/Users/dev/build/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya";
const FALLBACK = "/Applications/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya";

test("shim tries the baked path first and execs it", () => {
  const s = renderCliShim(PRIMARY, FALLBACK);
  assert.ok(s.startsWith("#!/bin/sh\n"));
  assert.ok(s.includes(`AYA_CLI='${PRIMARY}'`));
  assert.ok(s.includes('exec "$AYA_CLI"'));
});

test("shim falls back to the default install location when the baked path died", () => {
  const s = renderCliShim(PRIMARY, FALLBACK);
  assert.ok(s.includes(`AYA_CLI='${FALLBACK}'`));
  // fallback only engages when the primary is not executable
  assert.ok(/if \[ ! -x "\$AYA_CLI" \]/.test(s));
});

// Shell metacharacters must survive verbatim: double-quoted embedding would
// let sh expand $VARS and `backticks` at runtime and exec a mangled path
// (grok review finding). Single quotes inhibit all expansion.
test("paths with $, backticks and quotes are embedded expansion-proof", () => {
  const nasty = "/Users/dev/My $Work/`aya`/it's here/aya";
  const s = renderCliShim(nasty, null);
  assert.ok(s.includes("AYA_CLI='/Users/dev/My $Work/`aya`/it'\\''s here/aya'"));
  assert.deepEqual(parseShimTargets(s), [nasty]);
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

test("foreign scripts containing an AYA_CLI lookalike are NOT parsed (marker gate)", () => {
  const foreign = "#!/bin/sh\n# my notes: AYA_CLI='/shouldnot'\nAYA_CLI='/also/not'\necho hi\n";
  assert.deepEqual(parseShimTargets(foreign), []);
});

test("parseShimTargets understands the legacy #42 shim format", () => {
  const legacy = `#!/bin/sh\nexec ${JSON.stringify(FALLBACK)} "$@"\n`;
  assert.deepEqual(parseShimTargets(legacy), [FALLBACK]);
});

test("parseShimTargets returns [] for scripts that are not our shim", () => {
  assert.deepEqual(parseShimTargets("#!/bin/bash\necho hello\n"), []);
  assert.deepEqual(parseShimTargets(""), []);
});

// defaultInstallAyaCliPath: the macOS self-heal target (and "none" elsewhere).
// The platform param keeps it a pure, testable seam rather than reading
// process.platform directly.

test("defaultInstallAyaCliPath points at /Applications on macOS", () => {
  assert.equal(
    defaultInstallAyaCliPath("darwin"),
    "/Applications/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya",
  );
});

test("defaultInstallAyaCliPath has no well-known location off macOS", () => {
  assert.equal(defaultInstallAyaCliPath("linux"), null);
  assert.equal(defaultInstallAyaCliPath("win32"), null);
});
