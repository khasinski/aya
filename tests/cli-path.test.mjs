// The bundled aya CLI must resolve to a real, executable file in packaged
// builds. #39: the installed shim exec'd .../app.asar/bin/aya - a path inside
// the asar archive, which the OS cannot execute ("Not a directory") - because
// bin/ was packed into the asar and the resolver never pointed at the
// app.asar.unpacked copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  bundledAyaCliPath,
  bundledDistElectronHelperPath,
} from "../dist-electron/cli-path.js";

test("packaged build: app.asar dirname resolves to the app.asar.unpacked copy", () => {
  const dirname = "/Applications/Aya.app/Contents/Resources/app.asar/dist-electron";
  assert.equal(
    bundledAyaCliPath(dirname),
    "/Applications/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya",
  );
});

test("dev build: repo dist-electron resolves to the repo's real bin/aya", () => {
  const dirname = "/Users/dev/Projects/aya/dist-electron";
  assert.equal(bundledAyaCliPath(dirname), "/Users/dev/Projects/aya/bin/aya");
});

test("only an exact app.asar path segment is rewritten, not a lookalike", () => {
  // A directory NAMED like the archive but not the archive itself must not be
  // touched - rewriting it would point at a path that does not exist.
  const dirname = "/data/app.asar-backup/aya/dist-electron";
  assert.equal(
    bundledAyaCliPath(dirname),
    "/data/app.asar-backup/aya/bin/aya",
  );
});

test("packaged native dist-electron helper resolves to app.asar.unpacked", () => {
  const dirname = "/Applications/Aya.app/Contents/Resources/app.asar/dist-electron";
  assert.equal(
    bundledDistElectronHelperPath(dirname, "aya-local-summary"),
    "/Applications/Aya.app/Contents/Resources/app.asar.unpacked/dist-electron/aya-local-summary",
  );
});

test("dev native dist-electron helper resolves inside dist-electron", () => {
  const dirname = "/Users/dev/Projects/aya/dist-electron";
  assert.equal(
    bundledDistElectronHelperPath(dirname, "aya-local-summary"),
    "/Users/dev/Projects/aya/dist-electron/aya-local-summary",
  );
});

// Config-presence check, same rationale as entitlements.test.mjs: the unpack
// rule is a packaging detail no unit can exercise, so assert it exists. Without
// asarUnpack the rewritten path points at a directory electron-builder never
// materializes, and the shim is broken all the same.
test("electron-builder config unpacks bin/ out of the asar", () => {
  const pkg = JSON.parse(
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf8",
    ),
  );
  assert.ok(
    Array.isArray(pkg.build.asarUnpack) &&
      pkg.build.asarUnpack.includes("bin/**"),
    "package.json build.asarUnpack must include bin/** so the aya CLI is a real file",
  );
  assert.ok(
    Array.isArray(pkg.build.asarUnpack) &&
      pkg.build.asarUnpack.includes("dist-electron/aya-local-summary"),
    "package.json build.asarUnpack must include the native summary helper",
  );
});
