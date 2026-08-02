// Full fs round-trip for the usage-hook installer, isolated to a temp dir (the
// real ~/.claude is never touched). This covers what the pure-merge tests
// can't: that install actually writes the script + merges the hook into the
// settings FILE, is idempotent, and that uninstall removes both while leaving
// pre-existing config (other keys, other Stop hooks) intact.
//
// Env is set BEFORE importing the module so its load-time paths resolve into
// the temp dir. Node's test runner isolates each test file in its own process,
// so this can't leak into other suites.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aya-hook-test-"));
const settingsPath = join(root, "settings.json");
process.env.AYA_HOME = join(root, "aya"); // script + usage.json land here
process.env.AYA_CLAUDE_SETTINGS = settingsPath;

// Seed an existing settings file with unrelated config + a pre-existing Stop
// hook that MUST survive both install and uninstall.
writeFileSync(
  settingsPath,
  JSON.stringify({
    env: { FOO: "1" },
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "/existing.sh" }] }],
    },
  }),
);

const { installUsageHook, uninstallUsageHook, usageHookStatus, HOOK_SCRIPT_FILE } =
  await import("../dist-electron/usage-hook.js");

test("install writes script + merges hook; idempotent; uninstall reverts; existing config preserved", async () => {
  assert.equal((await usageHookStatus()).installed, false);

  // --- install ---
  const after = await installUsageHook();
  assert.equal(after.installed, true);
  assert.equal(existsSync(HOOK_SCRIPT_FILE), true);
  const s1 = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(s1.env.FOO, "1"); // unrelated key preserved
  assert.equal(s1.hooks.Stop[0].hooks[0].command, "/existing.sh"); // existing hook preserved
  assert.equal(s1.hooks.Stop.length, 2); // ours appended, not replacing
  assert.match(s1.hooks.Stop[1].hooks[0].command, /AYA_CLAUDE_CONFIG_DIR=/);
  assert.match(s1.hooks.Stop[1].hooks[0].command, new RegExp(HOOK_SCRIPT_FILE));

  // --- idempotent: install again must not duplicate ---
  await installUsageHook();
  const s2 = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(s2.hooks.Stop.length, 2);

  // --- uninstall ---
  const off = await uninstallUsageHook();
  assert.equal(off.installed, false);
  assert.equal(existsSync(HOOK_SCRIPT_FILE), false); // script removed
  const s3 = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(s3.hooks.Stop.length, 1); // back to just the pre-existing hook
  assert.equal(s3.hooks.Stop[0].hooks[0].command, "/existing.sh");
  assert.equal(s3.env.FOO, "1");
});

test.after(() => rmSync(root, { recursive: true, force: true }));
