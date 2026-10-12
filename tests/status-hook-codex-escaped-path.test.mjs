// Install, status and uninstall of Aya's Codex notify hook through the public functions, with an AYA_HOME whose path
// holds a backslash: the notify line is written escaped (tomlString), so the raw path is not in it. Before, status
// reported a conflict right after install, and uninstall left the line pointing Codex at a deleted script.
// HOME, AYA_HOME and CODEX_HOME are temp dirs set before import: the paths resolve at load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHome } from "./helpers/isolate-home.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-codex-hook-"));
isolateHome(root);
process.env.AYA_HOME = join(root, "a\\b", "aya");
mkdirSync(process.env.AYA_HOME, { recursive: true });
process.env.CODEX_HOME = join(root, "codex");
test.after(() => rmSync(root, { recursive: true, force: true }));

const hook = await import("../dist-electron/status-hook-codex.js");
const config = () => readFileSync(hook.codexConfigPath(), "utf8");

test("the script path really holds a backslash, so the written line is escaped", () => {
  assert.ok(hook.STATUS_HOOK_CODEX_SCRIPT_FILE.includes("\\"), hook.STATUS_HOOK_CODEX_SCRIPT_FILE);
});

test("install, then status and a second install see Aya's own line; uninstall removes it and the script", async () => {
  const installed = await hook.installStatusCodexHook();
  assert.deepEqual([installed.configured, installed.conflict], [true, false]);
  assert.equal(config(), `${hook.codexNotifyLine(hook.STATUS_HOOK_CODEX_SCRIPT_FILE)}\n`);
  assert.deepEqual(await hook.installStatusCodexHook(), installed, "a second install changes nothing");
  const removed = await hook.uninstallStatusCodexHook();
  assert.deepEqual([removed.configured, removed.conflict], [false, false]);
  assert.doesNotMatch(config(), /notify/);
  assert.equal(existsSync(hook.STATUS_HOOK_CODEX_SCRIPT_FILE), false);
});

test("a user's wrapper that is given Aya's script as an argument stays the user's", async () => {
  const theirs = `notify = ["/usr/bin/wrapper", ${JSON.stringify(hook.STATUS_HOOK_CODEX_SCRIPT_FILE)}]\n`;
  writeFileSync(hook.codexConfigPath(), theirs);
  assert.equal((await hook.installStatusCodexHook()).conflict, true);
  await hook.uninstallStatusCodexHook();
  assert.equal(config(), theirs, "uninstall left the user's line alone");
});
