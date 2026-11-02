// The usage-hook installer edits the user's ~/.claude/settings.json. The merge
// must add/remove ONLY our entry and never clobber other keys or other hooks.
// These pin that safety property on the pure functions that do the editing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasStopHook,
  withStatusLine,
  withoutStatusLine,
  hasStatusLine,
  statusLineCommand,
  wrappedStatusLineCommand,
  HOOK_SCRIPT_FILE,
  withoutStopHook,
  hookScriptSource,
  settingsFileForConfigDir,
} from "../dist-electron/usage-hook.js";
import { CLAUDE_SETTINGS_FILENAME } from "../dist-electron/usage.js";

const CMD = "/Users/x/.aya/aya-usage-hook.sh";

test("hasStopHook (legacy cleanup) finds our command among other Stop hooks", () => {
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

test("withoutStopHook removes only our entry, keeps the rest", () => {
  const before = {
    model: "opus",
    hooks: { Stop: [{ hooks: [{ command: "/keep.sh" }] }, { hooks: [{ type: "command", command: CMD }] }] },
  };
  const after = withoutStopHook(before, CMD);
  assert.equal(hasStopHook(after, CMD), false);
  assert.equal(after.hooks.Stop[0].hooks[0].command, "/keep.sh");
  assert.equal(after.model, "opus");
});

test("withoutStopHook drops now-empty Stop/hooks containers", () => {
  const after = withoutStopHook({ hooks: { Stop: [{ hooks: [{ type: "command", command: CMD }] }] } }, CMD);
  assert.equal("hooks" in after, false);
});

test("withoutStopHook is a no-op when our hook isn't present", () => {
  const s = { hooks: { Stop: [{ hooks: [{ command: "/keep.sh" }] }] } };
  const after = withoutStopHook(s, CMD);
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(after.hooks.Stop[0].hooks[0].command, "/keep.sh");
});

test("statusLine: no existing statusLine -> ours, and removal leaves none", () => {
  const after = withStatusLine({ model: "opus" }, "/c");
  assert.equal(after.model, "opus");
  assert.equal(after.statusLine.type, "command");
  assert.equal(hasStatusLine(after, "/c"), true);
  assert.equal(hasStatusLine(after, "/other"), false);
  assert.equal(wrappedStatusLineCommand(after.statusLine), undefined);
  const back = withoutStatusLine(after);
  assert.equal("statusLine" in back, false);
  assert.equal(back.model, "opus");
});

test("statusLine: the user's own command is wrapped, kept through reinstall, and restored", () => {
  const own = `bash -c 'echo "it'\\''s fine"' && x`;
  const before = { statusLine: { type: "command", command: own, padding: 2 } };
  const once = withStatusLine(before, "/c");
  assert.equal(wrappedStatusLineCommand(once.statusLine), own);
  assert.equal(once.statusLine.padding, 2);
  const twice = withStatusLine(once, "/c"); // idempotent: never wraps itself
  assert.deepEqual(twice, once);
  assert.deepEqual(withoutStatusLine(once), before);
  assert.equal(before.statusLine.command, own); // input not mutated
});

test("statusLine: a statusLine that is not a command is left alone", () => {
  const s = { statusLine: { type: "static", text: "x" } };
  assert.equal(withStatusLine(s, "/c"), s);
  assert.equal(withoutStatusLine(s), s);
});

test("statusLineCommand quotes the config dir and names the script", () => {
  const c = statusLineCommand("/a b/c", "next");
  assert.match(c, /^AYA_CLAUDE_CONFIG_DIR='\/a b\/c' AYA_STATUSLINE_NEXT_B64=\S+ /);
  assert.ok(c.includes(HOOK_SCRIPT_FILE));
});

test("hookScriptSource bakes the out path and throttle in, and never touches the network", () => {
  const s = hookScriptSource("/tmp/aya/usage.json");
  assert.match(s, /OUT="\/tmp\/aya\/usage\.json"/);
  assert.match(s, /-lt 30\b/);
  assert.doesNotMatch(s, /curl|oauth|security find|credentials/);
});

// GNU stat has to be tried before the BSD spelling, not after: "stat -f %m" on
// coreutils reads %m as a filename, prints a filesystem dump and only then fails,
// so an `|| stat -c %Y` fallback appends the mtime to that dump instead of
// replacing it.
test("hookScriptSource asks GNU stat first, BSD stat second", () => {
  const s = hookScriptSource("/tmp/aya/usage.json");
  assert.match(s, /stat -c %Y[\s\S]*stat -f %m/);
});

test("settingsFileForConfigDir: <configDir>/settings.json when AYA_CLAUDE_SETTINGS is unset", () => {
  const saved = process.env.AYA_CLAUDE_SETTINGS;
  delete process.env.AYA_CLAUDE_SETTINGS;
  try {
    assert.equal(CLAUDE_SETTINGS_FILENAME, "settings.json");
    assert.equal(settingsFileForConfigDir("/Users/x/.claude-work"), "/Users/x/.claude-work/settings.json");
  } finally {
    if (saved !== undefined) process.env.AYA_CLAUDE_SETTINGS = saved;
  }
});
