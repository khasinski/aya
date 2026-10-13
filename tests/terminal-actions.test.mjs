import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextActiveTerminalId,
  projectLaunchCwd,
  shellPresetForTab,
} from "../dist-test/terminal-actions.js";
import { PRESET_ID_SHELL } from "../dist-test/preset-ids.js";
import { BUILTIN_SHELL } from "../dist-test/types.js";

const project = { slug: "aya", directory: "/src/aya", name: "Aya", tabs: [] };
const preset = (id) => ({ id, name: id, command: id, icon: "", color: "" });
const terminal = (id, projectSlug = "aya") => ({
  id, projectSlug, presetId: "shell", name: id, cwd: "/src/aya",
  status: "running", bell: false, exitCode: null,
});

test("launch cwd uses the project directory when its fallback is absent", () => {
  assert.equal(projectLaunchCwd(project, {}), "/src/aya");
  assert.equal(projectLaunchCwd(project, { other: "/home/other" }), "/src/aya");
});

test("launch cwd honors this project's session fallback, including an empty path", () => {
  assert.equal(projectLaunchCwd(project, { aya: "/home/user" }), "/home/user");
  assert.equal(projectLaunchCwd(project, { aya: "" }), "");
});

test("shell shortcut selects the shell preset ahead of the first preset", () => {
  const agent = preset("agent");
  const shell = preset(PRESET_ID_SHELL);
  const duplicate = { ...shell, name: "Second shell" };
  assert.equal(shellPresetForTab([agent, shell, duplicate]), shell);
});

test("shell shortcut falls back to the first preset when shell was deleted", () => {
  const first = preset("codex");
  assert.equal(shellPresetForTab([first, preset("claude")]), first);
});

test("shell shortcut works with no presets", () => {
  assert.equal(shellPresetForTab([]), BUILTIN_SHELL);
});

test("closing an active tab selects the last remaining terminal of its project", () => {
  const terminals = {
    first: terminal("first"),
    closed: terminal("closed"),
    last: terminal("last"),
    other: terminal("other", "elsewhere"),
  };
  const next = { ...terminals };
  delete next.closed;
  assert.equal(nextActiveTerminalId(next, "aya"), "last");
  assert.deepEqual(Object.keys(next), ["first", "last", "other"]);
  assert.equal(terminals.closed.id, "closed");
});

test("closing the last project terminal leaves no active tab even if other projects remain", () => {
  assert.equal(nextActiveTerminalId({ other: terminal("other", "elsewhere") }, "aya"), null);
  assert.equal(nextActiveTerminalId({}, "aya"), null);
});

test("close selection follows terminal record order rather than terminal names", () => {
  assert.equal(nextActiveTerminalId({
    z: terminal("z"),
    a: terminal("a"),
  }, "aya"), "a");
});

test("successive closes advance selection through the current terminal record", () => {
  const remaining = { first: terminal("first"), last: terminal("last") };
  assert.equal(nextActiveTerminalId(remaining, "aya"), "last");
  delete remaining.last;
  assert.equal(nextActiveTerminalId(remaining, "aya"), "first");
  delete remaining.first;
  assert.equal(nextActiveTerminalId(remaining, "aya"), null);
});
