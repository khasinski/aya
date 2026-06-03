// The usage-hook installer edits the user's ~/.claude/settings.json. The merge
// must add/remove ONLY our entry and never clobber other keys or other hooks.
// These pin that safety property on the pure functions that do the editing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasStopHook,
  withStopHook,
  withoutStopHook,
  hookScriptSource,
} from "../dist-electron/usage-hook.js";

const CMD = "/Users/x/.aya/aya-usage-hook.sh";

test("hasStopHook finds our command among other Stop hooks", () => {
  const s = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "/other/thing.sh" }] },
        { hooks: [{ type: "command", command: CMD }] },
      ],
    },
  };
  assert.equal(hasStopHook(s, CMD), true);
  assert.equal(hasStopHook(s, "/nope.sh"), false);
});

test("hasStopHook is false for missing/garbage shapes", () => {
  assert.equal(hasStopHook({}, CMD), false);
  assert.equal(hasStopHook({ hooks: {} }, CMD), false);
  assert.equal(hasStopHook({ hooks: { Stop: "x" } }, CMD), false);
  assert.equal(hasStopHook(null, CMD), false);
});

test("withStopHook adds our entry but keeps other keys + Stop + hook kinds", () => {
  const before = {
    model: "opus",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/keep.sh" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "/pre.sh" }] }],
    },
  };
  const after = withStopHook(before, CMD);
  assert.equal(after.model, "opus"); // unrelated key intact
  assert.equal(after.hooks.Stop[0].hooks[0].command, "/keep.sh"); // other Stop hook intact
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "/pre.sh"); // other kind intact
  assert.equal(hasStopHook(after, CMD), true);
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(before.hooks.Stop.length, 1); // original not mutated
});

test("withStopHook is idempotent (never duplicates)", () => {
  const once = withStopHook({}, CMD);
  const twice = withStopHook(once, CMD);
  assert.equal(twice.hooks.Stop.length, 1);
});

test("withStopHook creates the structure from empty settings", () => {
  assert.equal(hasStopHook(withStopHook({}, CMD), CMD), true);
});

test("withoutStopHook removes only our entry, keeps the rest", () => {
  const before = withStopHook(
    {
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/keep.sh" }] }] },
    },
    CMD,
  );
  const after = withoutStopHook(before, CMD);
  assert.equal(hasStopHook(after, CMD), false);
  assert.equal(after.hooks.Stop[0].hooks[0].command, "/keep.sh");
  assert.equal(after.model, "opus");
});

test("withoutStopHook drops now-empty Stop/hooks containers", () => {
  const after = withoutStopHook(withStopHook({}, CMD), CMD);
  assert.equal("hooks" in after, false);
});

test("withoutStopHook is a no-op when our hook isn't present", () => {
  const s = { hooks: { Stop: [{ hooks: [{ command: "/keep.sh" }] }] } };
  const after = withoutStopHook(s, CMD);
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(after.hooks.Stop[0].hooks[0].command, "/keep.sh");
});

test("hookScriptSource bakes the out path, throttle, and curl timeout in", () => {
  const s = hookScriptSource("/tmp/aya/usage.json");
  assert.match(s, /OUT="\/tmp\/aya\/usage\.json"/); // writes the file Aya reads
  assert.match(s, /-lt 300\b/); // 5-min throttle from HOOK_THROTTLE_SECONDS
  assert.match(s, /-m 10\b/); // curl timeout from HOOK_FETCH_TIMEOUT_SECONDS
  assert.match(s, /oauth\/usage/); // queries the usage endpoint
});
