// The startup refresh rewrites only an installed, outdated hook script. AYA_HOME is
// set BEFORE importing: the script paths are resolved at module load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aya-status-refresh-"));
process.env.AYA_HOME = join(root, "aya");
mkdirSync(process.env.AYA_HOME, { recursive: true });

const claude = await import("../dist-electron/status-hook.js");
const codex = await import("../dist-electron/status-hook-codex.js");
const { EXECUTABLE_FILE_MODE } = await import("../dist-electron/paths.js");
const { HOOK_VIA } = await import("../dist-electron/constants.js");

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("hook scripts are executable and tag their aya calls via=hook", () => {
  assert.equal(EXECUTABLE_FILE_MODE, 0o755);
  assert.equal(HOOK_VIA, "hook");
});

test("the generated status-hook scripts are unchanged", () => {
  assert.equal(
    sha(claude.statusHookScriptSource("/opt/aya/bin/aya")),
    "fe84973e298190bdae61530b19f695275e77842be880f216638358dac8fadbef",
  );
  assert.equal(
    sha(codex.codexNotifyScriptSource("/opt/aya/bin/aya")),
    "00a93616672adea70d16166957d7ca804e43449e3f8c481668fd01164d626c6d",
  );
});

const cases = [
  ["claude", claude.STATUS_HOOK_SCRIPT_FILE, claude.refreshStatusHookScript],
  ["codex", codex.STATUS_HOOK_CODEX_SCRIPT_FILE, codex.refreshStatusCodexHookScript],
];

for (const [name, file, refresh] of cases) {
  test(`${name}: refresh never installs a missing script`, async () => {
    assert.equal(existsSync(file), false);
    await refresh();
    assert.equal(existsSync(file), false);
  });

  test(`${name}: refresh rewrites an outdated script as executable, leaves a current one alone`, async () => {
    writeFileSync(file, "#!/bin/sh\n# old\n");
    chmodSync(file, 0o600);
    await refresh();
    const fresh = readFileSync(file, "utf8");
    assert.notEqual(fresh, "#!/bin/sh\n# old\n");
    assert.match(fresh, /AYA_VIA=hook "\$AYA" status/);
    assert.equal(statSync(file).mode & 0o777, 0o755);
    chmodSync(file, 0o700);
    await refresh();
    assert.equal(readFileSync(file, "utf8"), fresh);
    assert.equal(statSync(file).mode & 0o777, 0o700, "a current script is not rewritten");
  });
}
