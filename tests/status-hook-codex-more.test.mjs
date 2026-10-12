// The fs-bound half of the Codex notify installer: install, uninstall and status read and
// write $CODEX_HOME/config.toml and the script in AYA_HOME. These pin that a user's own
// notify is never overwritten or removed, that install/uninstall round-trip the config, and
// that status reports configured only when both the config line and the script exist.
// HOME, AYA_HOME and CODEX_HOME are temp dirs set BEFORE import: the paths resolve at load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolateHome } from "./helpers/isolate-home.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-status-codex-"));
isolateHome(root);
mkdirSync(process.env.AYA_HOME, { recursive: true });
// Not created: install must create a Codex home that does not exist yet.
const codexHome = join(root, "codex-home", "nested");
process.env.CODEX_HOME = codexHome;

// Registered before the imports, so a failing import leaves no temp dir behind.
test.after(() => rmSync(root, { recursive: true, force: true }));
const codex = await import("../dist-electron/status-hook-codex.js");
const { bundledAyaCliPath } = await import("../dist-electron/cli-path.js");

const CONFIG = join(codexHome, "config.toml");
const SCRIPT = codex.STATUS_HOOK_CODEX_SCRIPT_FILE;
const OURS = `notify = ["${SCRIPT}"]`;
const THEIRS = `notify = ["/usr/bin/their-notifier", "--flag"]\nmodel = "gpt-5"\n`;
const readConfig = () => readFileSync(CONFIG, "utf8");

/** Each test starts from its own state: no config (or `toml`), no script. */
function reset(toml = null) {
  rmSync(SCRIPT, { force: true });
  rmSync(join(root, "codex-home"), { recursive: true, force: true });
  if (toml !== null) {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(CONFIG, toml);
  }
}

test("the config path is config.toml in CODEX_HOME and the script lives in AYA_HOME", () => {
  assert.equal(codex.codexConfigPath(), CONFIG);
  assert.equal(SCRIPT, join(resolve(process.env.AYA_HOME), "aya-status-codex-notify.sh"));
});

test("status with no config and no script is neither configured nor a conflict", async () => {
  reset();
  assert.deepEqual(await codex.statusCodexHookStatus(), {
    configured: false,
    conflict: false,
    scriptPath: SCRIPT,
    configPath: CONFIG,
  });
});

test("install into a missing Codex home creates it, writes our notify line and an executable script", async () => {
  reset();
  const status = await codex.installStatusCodexHook();
  assert.deepEqual(status, { configured: true, conflict: false, scriptPath: SCRIPT, configPath: CONFIG });
  assert.equal(readConfig(), `${OURS}\n`);
  assert.equal(statSync(SCRIPT).mode & 0o777, 0o755);
  // The script falls back to the CLI bundled next to dist-electron.
  const cli = bundledAyaCliPath(resolve("dist-electron"));
  assert.equal(readFileSync(SCRIPT, "utf8"), codex.codexNotifyScriptSource(cli));
});

test("install prepends to an existing config and a second install adds no duplicate line", async () => {
  const start = `model = "gpt-5"\n\n[tui]\nnotify = "x"\n`;
  reset(start);
  await codex.installStatusCodexHook();
  assert.equal(readConfig(), `${OURS}\n${start}`);
  const again = await codex.installStatusCodexHook();
  assert.equal(again.configured, true);
  assert.equal(readConfig(), `${OURS}\n${start}`);
});

test("install leaves a user's own notify byte-for-byte, writes no script and reports a conflict", async () => {
  reset(THEIRS);
  const status = await codex.installStatusCodexHook();
  assert.equal(status.configured, false);
  assert.equal(status.conflict, true);
  assert.equal(readConfig(), THEIRS);
  assert.equal(existsSync(SCRIPT), false);
});

test("our notify line without the script is not configured, and install writes the script back", async () => {
  reset(`${OURS}\n`);
  assert.deepEqual(await codex.statusCodexHookStatus(), {
    configured: false,
    conflict: false,
    scriptPath: SCRIPT,
    configPath: CONFIG,
  });
  const status = await codex.installStatusCodexHook();
  assert.equal(status.configured, true);
  assert.equal(existsSync(SCRIPT), true);
  assert.equal(readConfig(), `${OURS}\n`);
});

test("uninstall after install restores the original config and removes the script", async () => {
  const start = `model = "gpt-5"\n\n[tui]\nfoo = 1\n`;
  reset(start);
  await codex.installStatusCodexHook();
  const status = await codex.uninstallStatusCodexHook();
  assert.deepEqual(status, { configured: false, conflict: false, scriptPath: SCRIPT, configPath: CONFIG });
  assert.equal(readConfig(), start);
  assert.equal(existsSync(SCRIPT), false);
});

test("uninstall keeps a user's own notify and still reports it as a conflict", async () => {
  reset(THEIRS);
  writeFileSync(SCRIPT, "#!/bin/sh\n");
  const status = await codex.uninstallStatusCodexHook();
  assert.equal(readConfig(), THEIRS);
  assert.equal(existsSync(SCRIPT), false);
  assert.equal(status.conflict, true);
  assert.equal(status.configured, false);
});

test("uninstall with no Codex config does not create one", async () => {
  reset();
  const status = await codex.uninstallStatusCodexHook();
  assert.equal(existsSync(CONFIG), false);
  assert.equal(existsSync(codexHome), false);
  assert.equal(status.configured, false);
  assert.equal(status.conflict, false);
});

test("a notify under a table is not a conflict for status", async () => {
  reset(`model = "gpt-5"\n[tui]\nnotify = "x"\n`);
  const status = await codex.statusCodexHookStatus();
  assert.equal(status.conflict, false);
  assert.equal(status.configured, false);
});
