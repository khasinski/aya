// The status and usage hooks edit the same ~/.claude/settings.json: two edits started together must end as if run one
// after the other, or an unqueued read-modify-write drops the other's hooks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHome } from "./helpers/isolate-home.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-settings-writers-test-"));
const settingsPath = join(root, "settings.json");
isolateHome(root);
process.env.AYA_CLAUDE_SETTINGS = settingsPath;

const status = await import("../dist-electron/status-hook.js");
const usage = await import("../dist-electron/usage-hook.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

const OPS = {
  "status install": status.installStatusHook,
  "status uninstall": status.uninstallStatusHook,
  "status migrate": status.migrateStatusHookCommand,
  "usage install": usage.installUsageHook,
  "usage uninstall": usage.uninstallUsageHook,
};
const other = { hooks: [{ type: "command", command: "/existing.sh" }] };
const quoted = `'${status.STATUS_HOOK_SCRIPT_FILE}'`;
const legacy = Object.fromEntries(status.STATUS_HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: quoted }] }]]));
const STARTS = {
  "no file": null,
  "only the user's own hooks": { env: { FOO: "1" }, hooks: { Stop: [other] } },
  "a quoted status hook from an old build": { hooks: { ...legacy, Stop: [other, ...legacy.Stop] } },
};

const seed = (start) => (start === null ? rmSync(settingsPath, { force: true }) : writeFileSync(settingsPath, JSON.stringify(start)));
const read = () => {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
};

for (const [startName, start] of Object.entries(STARTS)) {
  for (const [a, opA] of Object.entries(OPS)) {
    for (const [b, opB] of Object.entries(OPS)) {
      test(`${a} then ${b} started together, from ${startName}, end as if run in turn`, async () => {
        seed(start);
        await opA();
        await opB();
        const inTurn = read();
        seed(start);
        await Promise.all([opA(), opB()]);
        assert.deepEqual(read(), inTurn);
      });
    }
  }
}

test("many edits started together run in the order they were started", async () => {
  for (let round = 0; round < 3; round += 1) {
    seed(null);
    const ops = [...Array(15).fill(usage.uninstallUsageHook), usage.installUsageHook];
    await Promise.all(ops.map((op) => op()));
    assert.equal((await usage.usageHookStatus()).installed, true, "the install started last ran last");
  }
});
