// The hook command Aya writes, run by the REAL Claude Code and Grok (Grok runs a no-space command as a literal
// path). Costs a model call each, so off unless AYA_REAL_CLI=1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWithoutAya } from "./helpers/env.mjs";
import { isolateHome } from "./helpers/isolate-home.mjs";

const realHome = process.env.HOME;
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR;
const enabled = process.env.AYA_REAL_CLI === "1";
const root = mkdtempSync(join(tmpdir(), "aya-real-hook-"));
const home = join(root, "home");
const settingsPath = join(home, ".claude", "settings.json");
mkdirSync(join(home, ".claude"), { recursive: true });
isolateHome(root);
process.env.AYA_CLAUDE_SETTINGS = settingsPath;

const { hookCommandFor, installStatusHook, withStatusHooks, STATUS_HOOK_SCRIPT_FILE } =
  await import("../dist-electron/status-hook.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

/** Stands in for the status script: same path, same executable bit, but it
 *  leaves a marker instead of calling `aya status`. */
function writeMarkerScript(scriptPath, marker) {
  mkdirSync(join(scriptPath, ".."), { recursive: true });
  writeFileSync(scriptPath, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
}

const claudeEnv = () => {
  const env = { ...envWithoutAya(), HOME: realHome };
  for (const key of Object.keys(env)) if (key.startsWith("CLAUDE")) delete env[key];
  if (realClaudeDir) env.CLAUDE_CONFIG_DIR = realClaudeDir;
  return env;
};

/** Claude keeps its login in the keychain per config dir, so it runs with the
 *  real one and takes the hook through --settings; the shell runs the command either way. */
const CLIS = {
  grok: {
    available: existsSync(join(realHome, ".grok", "auth.json")),
    run(cwd, file) {
      const grokHome = join(root, "grok-home");
      mkdirSync(grokHome, { recursive: true });
      for (const name of ["auth.json", "config.toml"]) copyFileSync(join(realHome, ".grok", name), join(grokHome, name));
      return spawnSync("grok", ["-p", "say ok"], {
        cwd, encoding: "utf8", timeout: 180_000, input: "",
        env: { ...envWithoutAya(), HOME: home, GROK_HOME: grokHome },
      });
    },
  },
  claude: {
    available: true,
    run(cwd, file) {
      return spawnSync("claude", ["-p", "--model", "claude-sonnet-5-5", "--no-session-persistence", "--settings", file, "say ok"], {
        cwd, encoding: "utf8", timeout: 180_000, input: "", env: claudeEnv(),
      });
    },
  },
};

for (const [name, cli] of Object.entries(CLIS)) {
  for (const [dirName, dir] of [["plain dir", join(root, "plain")], ["dir with a space", join(root, "with space")]]) {
    test(`${name} executes the status hook command as Aya writes it (${dirName})`, { skip: !enabled || !cli.available }, () => {
      const marker = join(root, `${name}-${dirName.replace(/ /g, "_")}.marker`);
      const script = join(dir, "aya-status-hook.sh");
      writeMarkerScript(script, marker);
      writeFileSync(settingsPath, JSON.stringify(withStatusHooks({}, hookCommandFor(script))));
      const cwd = join(root, "proj");
      mkdirSync(cwd, { recursive: true });
      const r = cli.run(cwd, settingsPath);
      const out = `${r.stdout}${r.stderr}`;
      console.log(`# ${name} / ${dirName}: exit ${r.status}, marker ${existsSync(marker)}, output: ${out.trim().slice(0, 200)}`);
      assert.equal(existsSync(marker), true, `the hook never ran: ${out}`);
      assert.doesNotMatch(out, /not found|No such file|Permission denied/i);
    });
  }

  test(`${name} executes the command installStatusHook writes`, { skip: !enabled || !cli.available }, async () => {
    const marker = join(root, `${name}-installed.marker`);
    await installStatusHook();
    writeMarkerScript(STATUS_HOOK_SCRIPT_FILE, marker);
    const cwd = join(root, "proj");
    mkdirSync(cwd, { recursive: true });
    const r = cli.run(cwd, settingsPath);
    assert.equal(existsSync(marker), true, `the hook never ran: ${r.stdout}${r.stderr}`);
    assert.match(readFileSync(marker, "utf8"), /ran/);
  });
}
