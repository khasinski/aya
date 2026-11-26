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

// An updated Aya adopts the running PTY owner only when the owner files hash equal; a re-signed identical owner never does.
test("a release keeps the previous release's signed PTY owner when the code directory is the same", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pinOwner } = require("../scripts/sign-macos.cjs");
  const setup = ({ fresh, pin, freshTeam = "DRR99SUARM", pinValid = true }) => {
    const root = mkdtempSync(join(tmpdir(), "aya-pin-"));
    const app = join(root, "Aya.app"), dir = join(app, "Contents/Resources/app.asar.unpacked/dist-electron");
    mkdirSync(dir, { recursive: true });
    const owner = join(dir, "aya-pty-owner"), pinned = join(root, "pin", "aya-pty-owner-darwin-arm64");
    writeFileSync(owner, "fresh-bytes");
    if (pin) { mkdirSync(join(root, "pin")); writeFileSync(pinned, "pinned-bytes"); }
    const signatures = { [owner]: { cd: fresh, team: freshTeam }, [pinned]: { cd: pin, team: "DRR99SUARM" } };
    const run = (file, args) => {
      const target = args.at(-1);
      if (args[0] === "--verify") return { status: pinValid ? 0 : 1, stderr: "" };
      const s = signatures[target];
      return { status: 0, stdout: "", stderr: `Executable=${target}\nCDHash=${s.cd}\nTeamIdentifier=${s.team ?? "not set"}\n` };
    };
    return { app, owner, pinned, run };
  };
  const same = "257f591b78f4d8bc8cce5758e22418f4d7c16541", other = "1111111111111111111111111111111111111111";
  const quiet = () => {};

  let t = setup({ fresh: same, pin: same });
  assert.equal(pinOwner(t.app, { pinned: t.pinned, run: t.run, log: quiet }), true);
  assert.equal(readFileSync(t.owner, "utf8"), "pinned-bytes");

  t = setup({ fresh: other, pin: same });
  assert.equal(pinOwner(t.app, { pinned: t.pinned, run: t.run, log: quiet }), false);
  assert.equal(readFileSync(t.owner, "utf8"), "fresh-bytes");
  assert.equal(readFileSync(t.pinned, "utf8"), "fresh-bytes", "a changed owner becomes the next release's pin");

  t = setup({ fresh: same, pin: same, pinValid: false });
  assert.equal(pinOwner(t.app, { pinned: t.pinned, run: t.run, log: quiet }), false);
  assert.equal(readFileSync(t.owner, "utf8"), "fresh-bytes", "an invalid pinned signature is never shipped");

  t = setup({ fresh: same, pin: same, freshTeam: null });
  assert.equal(pinOwner(t.app, { pinned: t.pinned, run: t.run, log: quiet }), false);
  assert.equal(readFileSync(t.pinned, "utf8"), "pinned-bytes", "an ad-hoc local package leaves the release pin alone");

  t = setup({ fresh: same, pin: same });
  assert.equal(pinOwner(t.app, { pinned: t.pinned, identity: "-", run: t.run, log: quiet }), false);

  t = setup({ fresh: same });
  assert.equal(pinOwner(t.app, { pinned: t.pinned, run: t.run, log: quiet }), false);
  assert.ok(existsSync(t.pinned), "the first signed release writes the pin");
});
