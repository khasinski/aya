// Install, startup migration and uninstall of the status hook against a temp
// settings file and a temp HOME, so nothing can reach the real ~/.claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aya-status-hook-test-"));
const settingsPath = join(root, "settings.json");
process.env.AYA_HOME = join(root, "aya");
process.env.AYA_CLAUDE_SETTINGS = settingsPath;
process.env.HOME = join(root, "home");
delete process.env.CLAUDE_CONFIG_DIR;

const { installStatusHook, migrateStatusHookCommand, uninstallStatusHook, STATUS_HOOK_EVENTS, STATUS_HOOK_SCRIPT_FILE } =
  await import("../dist-electron/status-hook.js");

const quoted = `'${STATUS_HOOK_SCRIPT_FILE}'`;
const other = { hooks: [{ type: "command", command: "/existing.sh" }] };
const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));
const commands = (s, event) => (s.hooks?.[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command));

function seedQuoted() {
  const hooks = Object.fromEntries(STATUS_HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: quoted }] }]]));
  hooks.Stop.unshift(other);
  writeFileSync(settingsPath, JSON.stringify({ env: { FOO: "1" }, hooks }));
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("startup migration swaps the quoted command for the bare path and keeps other hooks", async () => {
  seedQuoted();
  await migrateStatusHookCommand();
  const s = read();
  for (const event of STATUS_HOOK_EVENTS) assert.deepEqual(commands(s, event).filter((c) => c !== "/existing.sh"), [STATUS_HOOK_SCRIPT_FILE], event);
  assert.equal(s.env.FOO, "1");
  assert.equal(commands(s, "Stop")[0], "/existing.sh");
});

test("startup migration never installs the hook", async () => {
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [other] } }));
  await migrateStatusHookCommand();
  assert.deepEqual(read(), { hooks: { Stop: [other] } });
});

test("install over a quoted entry leaves one command per event", async () => {
  seedQuoted();
  await installStatusHook();
  for (const event of STATUS_HOOK_EVENTS) {
    assert.deepEqual(commands(read(), event).filter((c) => c !== "/existing.sh"), [STATUS_HOOK_SCRIPT_FILE], event);
  }
});

test("uninstall removes both the bare and the quoted command", async () => {
  seedQuoted();
  await installStatusHook();
  const s = read();
  s.hooks.Notification.push({ hooks: [{ type: "command", command: quoted }] });
  writeFileSync(settingsPath, JSON.stringify(s));
  await uninstallStatusHook();
  assert.deepEqual(read(), { env: { FOO: "1" }, hooks: { Stop: [other] } });
});
