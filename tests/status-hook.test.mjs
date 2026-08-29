// The status-hook installer edits the user's ~/.claude/settings.json across
// three lifecycle events. Like the usage hook, the merge must add/remove ONLY
// our entry and never clobber other keys or other hooks. These pin that safety
// property on the pure functions that do the editing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasEventHook,
  withEventHook,
  withoutEventHook,
  withStatusHooks,
  withoutStatusHooks,
  statusHookScriptSource,
  STATUS_HOOK_EVENTS,
} from "../dist-electron/status-hook.js";

const CMD = "'/Users/x/.aya/aya-status-hook.sh'";

test("the three events we register are Notification, PostToolUse, Stop", () => {
  assert.deepEqual([...STATUS_HOOK_EVENTS].sort(), [
    "Notification",
    "PostToolUse",
    "Stop",
  ]);
});

test("withStatusHooks adds our command under every event, idempotently", () => {
  const once = withStatusHooks({}, CMD);
  for (const e of STATUS_HOOK_EVENTS) assert.equal(hasEventHook(once, e, CMD), true);
  // Applying again changes nothing (same reference back per event).
  const twice = withStatusHooks(once, CMD);
  assert.deepEqual(twice, once);
});

test("withStatusHooks preserves other keys and other hooks in the same events", () => {
  const start = {
    permissions: { allow: ["Bash"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/other/thing.sh" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "/keep.sh" }] }],
    },
  };
  const next = withStatusHooks(start, CMD);
  // Our entries are present…
  for (const e of STATUS_HOOK_EVENTS) assert.equal(hasEventHook(next, e, CMD), true);
  // …and nothing else was touched.
  assert.deepEqual(next.permissions, { allow: ["Bash"] });
  assert.equal(hasEventHook(next, "Stop", "/other/thing.sh"), true);
  assert.deepEqual(next.hooks.PreToolUse, start.hooks.PreToolUse);
});

test("withoutStatusHooks removes only our command and drops empty containers", () => {
  const withOurs = withStatusHooks(
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/thing.sh" }] }] } },
    CMD,
  );
  const cleaned = withoutStatusHooks(withOurs, CMD);
  for (const e of STATUS_HOOK_EVENTS) assert.equal(hasEventHook(cleaned, e, CMD), false);
  // The unrelated Stop hook survives; the Notification/PostToolUse arrays we
  // created and then emptied are gone entirely.
  assert.equal(hasEventHook(cleaned, "Stop", "/other/thing.sh"), true);
  assert.equal(cleaned.hooks.Notification, undefined);
  assert.equal(cleaned.hooks.PostToolUse, undefined);
});

test("withoutStatusHooks on settings with no hooks is a no-op", () => {
  const s = { permissions: {} };
  assert.equal(withoutStatusHooks(s, CMD), s);
});

test("withEventHook / withoutEventHook are idempotent and safe in isolation", () => {
  const added = withEventHook({}, "Notification", CMD);
  assert.equal(hasEventHook(added, "Notification", CMD), true);
  assert.equal(withEventHook(added, "Notification", CMD), added); // no dup
  const removed = withoutEventHook(added, "Notification", CMD);
  assert.equal(hasEventHook(removed, "Notification", CMD), false);
  assert.deepEqual(removed, {});
});

test("hasEventHook is false for missing / garbage shapes", () => {
  assert.equal(hasEventHook({}, "Stop", CMD), false);
  assert.equal(hasEventHook({ hooks: null }, "Stop", CMD), false);
  assert.equal(hasEventHook({ hooks: { Stop: "x" } }, "Stop", CMD), false);
  assert.equal(hasEventHook(null, "Stop", CMD), false);
});

test("the generated script maps each event to the right aya status level and no-ops outside Aya", () => {
  const src = statusHookScriptSource("/Applications/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya");
  // No-op guards outside an Aya terminal.
  assert.match(src, /AYA_SOCKET:-.*\|\| exit 0/);
  assert.match(src, /AYA_TERMINAL_ID:-.*\|\| exit 0/);
  // Event → level mapping.
  assert.match(src, /Notification\)[\s\S]*status waiting/);
  assert.match(src, /PostToolUse\)[\s\S]*status active "running \$TOOL"/);
  assert.match(src, /Stop\)[\s\S]*status done/);
  // The bundled CLI path is baked as the PATH fallback.
  assert.match(src, /app\.asar\.unpacked\/bin\/aya/);
});
