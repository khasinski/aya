// Harness auto-detection guardrails. The scan list is hard-coded, but these
// tests keep future additions shell-safe and suitable for first-launch seeding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_HARNESSES, isSafeBinaryName } from "../dist-electron/harnesses.js";

test("known harnesses have unique ids, binaries, and commands", () => {
  const ids = new Set();
  const binaries = new Set();
  const commands = new Set();

  for (const h of KNOWN_HARNESSES) {
    assert.ok(h.id, "id is required");
    assert.ok(h.binary, `${h.id} binary is required`);
    assert.ok(h.name, `${h.id} name is required`);
    assert.ok(h.icon, `${h.id} icon is required`);
    assert.ok(h.command, `${h.id} command is required`);

    assert.ok(!ids.has(h.id), `duplicate id: ${h.id}`);
    assert.ok(!binaries.has(h.binary), `duplicate binary: ${h.binary}`);
    assert.ok(!commands.has(h.command), `duplicate command: ${h.command}`);
    ids.add(h.id);
    binaries.add(h.binary);
    commands.add(h.command);
  }
});

test("known harness binaries are safe shell tokens", () => {
  for (const h of KNOWN_HARNESSES) {
    assert.ok(isSafeBinaryName(h.binary), `${h.id} has unsafe binary token`);
  }
});

test("binary safety rejects shell metacharacters instead of sanitizing", () => {
  for (const bad of ["bad;echo", "two words", "$(cmd)", "`cmd`", "x/y"]) {
    assert.equal(isSafeBinaryName(bad), false, bad);
  }
  for (const good of ["claude", "opencode", "my-tool_1.2"]) {
    assert.equal(isSafeBinaryName(good), true, good);
  }
});
