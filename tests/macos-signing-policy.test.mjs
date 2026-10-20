import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { macSigningMode } = require("../scripts/macos-signing-policy.cjs");
const { verifyStagedApp } = require("../scripts/sign-macos.cjs");

test("macOS package signing keeps a discovered identity and falls back only when none exists", () => {
  assert.equal(macSigningMode({ platform: "darwin", identity: undefined, identityFound: true }), "identity");
  assert.equal(macSigningMode({ platform: "darwin", identity: undefined, identityFound: false }), "ad-hoc-fallback");
  assert.equal(macSigningMode({ platform: "darwin", identity: null, identityFound: false }), "ad-hoc-fallback");
  assert.equal(macSigningMode({ platform: "darwin", identity: "-", identityFound: true }), "ad-hoc-configured");
  assert.equal(macSigningMode({ platform: "linux", identity: undefined, identityFound: false }), "not-macOS");
});

test("staged macOS signatures are verified deep and strict, and verification failure aborts", () => {
  let invocation;
  verifyStagedApp("/tmp/Aya.app", (file, args, options) => {
    invocation = { file, args, options };
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(invocation, {
    file: "codesign",
    args: ["--verify", "--deep", "--strict", "/tmp/Aya.app"],
    options: { encoding: "utf8" },
  });
  assert.throws(() => verifyStagedApp("/tmp/Aya.app", () => ({ status: 1, stderr: "invalid signature" })), /codesign verification failed.*invalid signature/);
});
