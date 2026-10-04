// Grok runs Claude's status hook too. Stop reports the turn's end and the screen owns dialogs, so no
// Notification (Claude sends 12 kinds) reports anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHome } from "./helpers/isolate-home.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-status-notification-"));
const settingsPath = join(root, "settings.json");
isolateHome(root);
process.env.AYA_CLAUDE_SETTINGS = settingsPath;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { statusHookScriptSource, installStatusHook, migrateStatusHookCommand, statusHookStatus, uninstallStatusHook, STATUS_HOOK_SCRIPT_FILE } =
  await import("../dist-electron/status-hook.js");

const SCRIPT = join(root, "hook.sh");
const FAKE_AYA = join(root, "fake-aya");
const CALLS = join(root, "calls");
writeFileSync(SCRIPT, statusHookScriptSource(FAKE_AYA));
chmodSync(SCRIPT, 0o755);
writeFileSync(FAKE_AYA, `#!/bin/sh\nprintf '%s|' "$AYA_VIA" "$@" >> '${CALLS}'\nprintf '\\n' >> '${CALLS}'\n`);
chmodSync(FAKE_AYA, 0o755);

/** What the hook script asks aya for, given one hook event's JSON. */
function ayaCalls(event) {
  rmSync(CALLS, { force: true });
  execFileSync(SCRIPT, [], {
    input: JSON.stringify(event),
    env: { PATH: `/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`, AYA_SOCKET: join(root, "s.sock"), AYA_TERMINAL_ID: "pane-1" },
  });
  return existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n") : [];
}

const NOTIFICATION_TYPES = [
  "permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog", "elicitation_url_dialog", "elicitation_complete",
  "elicitation_response", "agent_needs_input", "agent_completed", "quota_auto_resume_fired", "quota_auto_resume_stale", "quota_auto_resume_disabled",
];

for (const cli of ["claude", "grok"]) {
  for (const type of NOTIFICATION_TYPES) {
    test(`status hook | ${cli} Notification ${type} reports nothing`, () => {
      assert.deepEqual(ayaCalls({ hook_event_name: "Notification", notification_type: type, message: "Claude needs your permission to use Bash" }), []);
    });
  }
}

// [label, event JSON, aya calls]
const EVENTS = [
  ["Stop: the turn finished", { hook_event_name: "Stop" }, ["hook|status|done|Turn finished|"]],
  ["PostToolUse of the agent", { hook_event_name: "PostToolUse", tool_name: "Bash" }, ["hook|status|active|running Bash|"]],
  ["PostToolUse of a subagent (agent_id)", { hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "sub-1" }, []],
  ["StopFailure on a rate limit", { hook_event_name: "StopFailure", error_type: "rate_limit" }, ["hook|status|error|Turn ended: rate_limit|"]],
  ["StopFailure with no reason given", { hook_event_name: "StopFailure" }, ["hook|status|error|Turn ended with an API error|"]],
];
for (const [label, event, calls] of EVENTS) {
  test(`status hook | ${label}`, () => {
    assert.deepEqual(ayaCalls(event), calls);
  });
}

const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));
const commands = (s, event) => (s.hooks?.[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command));
const OURS = STATUS_HOOK_SCRIPT_FILE;
const OTHER = { hooks: [{ type: "command", command: "/their-notify.sh" }] };
const entry = (command) => ({ hooks: [{ type: "command", command }] });

test("status hook settings | install registers PostToolUse, Stop and StopFailure, never Notification", async () => {
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [OTHER] } }));
  await installStatusHook();
  const s = read();
  for (const event of ["PostToolUse", "Stop", "StopFailure"]) assert.deepEqual(commands(s, event), [OURS], event);
  assert.deepEqual(commands(s, "Notification"), ["/their-notify.sh"]);
  assert.equal((await statusHookStatus()).installed, true);
});

test("status hook settings | an install from before: startup drops our Notification, adds StopFailure, keeps theirs", async () => {
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [OTHER, entry(OURS)], PostToolUse: [entry(OURS)], Stop: [entry(OURS)] } }));
  writeFileSync(STATUS_HOOK_SCRIPT_FILE, "#!/bin/sh\n");
  await migrateStatusHookCommand();
  const s = read();
  assert.deepEqual(commands(s, "Notification"), ["/their-notify.sh"]);
  for (const event of ["PostToolUse", "Stop", "StopFailure"]) assert.deepEqual(commands(s, event), [OURS], event);
  assert.equal((await statusHookStatus()).installed, true);
});

test("status hook settings | an old quoted install is migrated the same way", async () => {
  const quoted = `'${OURS}'`;
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [entry(quoted)], PostToolUse: [entry(quoted)], Stop: [entry(quoted)] } }));
  await migrateStatusHookCommand();
  const s = read();
  assert.equal(s.hooks.Notification, undefined);
  for (const event of ["PostToolUse", "Stop", "StopFailure"]) assert.deepEqual(commands(s, event), [OURS], event);
});

test("status hook settings | startup never installs the hook", async () => {
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [OTHER] } }));
  await migrateStatusHookCommand();
  assert.deepEqual(read(), { hooks: { Notification: [OTHER] } });
});

test("status hook settings | uninstall removes ours from Notification too", async () => {
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [OTHER, entry(OURS)], Stop: [entry(OURS)] } }));
  await uninstallStatusHook();
  assert.deepEqual(read(), { hooks: { Notification: [OTHER] } });
});

test("status hook settings | an install left only under Notification is still ours: startup moves it to the current events", async () => {
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [entry(OURS)] } }));
  await migrateStatusHookCommand();
  const s = read();
  assert.equal(s.hooks.Notification, undefined);
  for (const event of ["PostToolUse", "Stop", "StopFailure"]) assert.deepEqual(commands(s, event), [OURS], event);
});

test("status hook settings | a current install beside their Notification is not rewritten at startup", async () => {
  const text = JSON.stringify({ hooks: { Notification: [OTHER], PostToolUse: [entry(OURS)], Stop: [entry(OURS)], StopFailure: [entry(OURS)] } });
  writeFileSync(settingsPath, text);
  await migrateStatusHookCommand();
  assert.equal(readFileSync(settingsPath, "utf8"), text);
});
