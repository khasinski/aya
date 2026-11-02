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
import { isolateHome } from "./helpers/isolate-home.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-hook-test-"));
const settingsPath = join(root, "settings.json");
isolateHome(root);
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

const { installUsageHook, uninstallUsageHook, usageHookStatus, refreshUsageHookScript, wrappedStatusLineCommand, HOOK_SCRIPT_FILE } =
  await import("../dist-electron/usage-hook.js");

test("install registers the statusLine; idempotent; uninstall restores the user's own; existing config preserved", async () => {
  assert.equal((await usageHookStatus()).installed, false);
  const own = "/existing-statusline.sh";
  const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));
  const seed = read();
  seed.statusLine = { type: "command", command: own };
  writeFileSync(settingsPath, JSON.stringify(seed));

  const after = await installUsageHook();
  assert.equal(after.installed, true);
  assert.equal(existsSync(HOOK_SCRIPT_FILE), true);
  const s1 = read();
  assert.equal(s1.env.FOO, "1");
  assert.equal(s1.hooks.Stop.length, 1); // the other Stop hook is untouched, none added
  assert.equal(s1.hooks.Stop[0].hooks[0].command, "/existing.sh");
  assert.match(s1.statusLine.command, /AYA_CLAUDE_CONFIG_DIR=/);
  assert.match(s1.statusLine.command, new RegExp(HOOK_SCRIPT_FILE));
  assert.equal(wrappedStatusLineCommand(s1.statusLine), own);

  await installUsageHook();
  assert.deepEqual(read(), s1);

  const off = await uninstallUsageHook();
  assert.equal(off.installed, false);
  assert.equal(existsSync(HOOK_SCRIPT_FILE), false);
  const s3 = read();
  assert.deepEqual(s3.statusLine, { type: "command", command: own });
  assert.equal(s3.hooks.Stop.length, 1);
  assert.equal(s3.env.FOO, "1");
});

test("launch migrates a leftover endpoint Stop hook to the statusLine", async () => {
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  delete s.statusLine;
  const legacy = `AYA_CLAUDE_CONFIG_DIR='${root}' '${HOOK_SCRIPT_FILE}'`;
  s.hooks.Stop.push({ hooks: [{ type: "command", command: legacy }] });
  writeFileSync(settingsPath, JSON.stringify(s));
  await refreshUsageHookScript();
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(after.hooks.Stop[0].hooks[0].command, "/existing.sh");
  assert.equal((await usageHookStatus()).installed, true);
  await uninstallUsageHook();
});

test("launch never installs for a user who had the chip off", async () => {
  await refreshUsageHookScript();
  assert.equal((await usageHookStatus()).installed, false);
  assert.equal(existsSync(HOOK_SCRIPT_FILE), false);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
