// The renderer's preset helpers in src/types.ts: getPreset (what a tab shows and
// spawns when its preset is gone), presetSlug (the id a new or imported preset
// gets), looksNonInteractive (the Settings warning under a preset's command).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_SHELL,
  getPreset,
  looksNonInteractive,
  presetSlug,
} from "../dist-test/types.js";
import { PRESET_ID_SHELL } from "../dist-test/preset-ids.js";
import { isPreset } from "../dist-electron/presets.js";

const preset = (id, extra = {}) => ({
  id,
  name: `Name of ${id}`,
  icon: "C",
  color: "#ffffff",
  command: `run-${id}`,
  ...extra,
});

test("getPreset returns the user's own preset, even one with the shell id", () => {
  const claude = preset("claude");
  const ownShell = preset(PRESET_ID_SHELL, { name: "zsh", command: "/bin/zsh -l" });
  const list = [claude, ownShell];
  assert.equal(getPreset(list, "claude"), claude);
  // A user's own shell preset wins over the built-in fallback.
  assert.equal(getPreset(list, PRESET_ID_SHELL), ownShell);
});

test("Cmd+T still opens a shell after the user deleted the shell preset", () => {
  const got = getPreset([preset("claude")], PRESET_ID_SHELL);
  assert.equal(got, BUILTIN_SHELL);
  assert.equal(got.id, PRESET_ID_SHELL);
  assert.equal(got.command, "$SHELL");
  assert.equal(got.name, "Shell");
});

test("a tab whose preset was deleted shows a missing preset and restores as a shell, not as the deleted one", () => {
  for (const list of [[], [preset("claude")]]) {
    for (const id of ["codex-work", "", "__proto__", "constructor"]) {
      const got = getPreset(list, id);
      assert.match(got.name, /missing/i, `name for ${JSON.stringify(id)}`);
      assert.notEqual(got.name, BUILTIN_SHELL.name);
      assert.notEqual(got, BUILTIN_SHELL);
      assert.notEqual(got.id, PRESET_ID_SHELL);
      assert.ok(got.id && got.id !== id, "the placeholder never claims the deleted id");
      // App.tsx restores such a tab with this preset: an empty command would fail
      // the spawn (preset-empty-command) instead of giving the user a shell.
      assert.equal(got.command, "$SHELL");
      assert.ok(got.icon, "the sidebar has an icon to draw");
    }
  }
});

test("presetSlug turns a preset name into a readable id", () => {
  assert.equal(presetSlug("Dev Server"), "dev-server");
  assert.equal(presetSlug("  Claude (work)  "), "claude-work");
  assert.equal(presetSlug("codex_2"), "codex_2");
  assert.equal(presetSlug("Zażółć gęślą"), "za-g-l");
});

test("presetSlug never yields an empty id, which the preset validator would reject", () => {
  for (const name of ["", "   ", "###", "---", "ąę", "日本語", "..."]) {
    const id = presetSlug(name);
    assert.equal(id, "preset", `slug for ${JSON.stringify(name)}`);
    assert.ok(isPreset({ id, name, icon: "", color: "", command: "x" }));
  }
});

test("an id built from a repo-supplied preset id is a plain slug, whatever the repo wrote", () => {
  // App.tsx uniquePresetId: presetSlug(`${project.slug}-${preset.id || preset.name}`),
  // where preset.id comes from the repo's .aya/project.json.
  const hostile = [
    "../../etc/passwd",
    "a/b\\c",
    "x\u0000y",
    "$(rm -rf ~)",
    "<img src=x onerror=alert(1)>",
    "\u202eevil",
    "-leading-and-trailing-",
    "CAPS and spaces",
  ];
  for (const id of hostile) {
    const slug = presetSlug(`my-repo-${id}`);
    assert.match(slug, /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/, `slug for ${JSON.stringify(id)}`);
    assert.ok(slug.startsWith("my-repo"), slug);
  }
});

test("looksNonInteractive warns for Claude switched to print mode", () => {
  const warn = [
    "claude -p",
    "claude --print",
    'claude -p "summarize the diff"',
    "claude --print --output-format json",
    "claude --print=true",
    "CLAUDE_CONFIG_DIR=~/.claude-work claude -p hi",
    "claude --dangerously-skip-permissions -p hi",
    "cd ~/src && claude -p hi",
    "env CLAUDE_CONFIG_DIR=~/.claude-work claude -p hi",
    'claude --append-system-prompt "be brief" -p hi',
    "claude\t-p",
    "claude --headless",
    "claude --non-interactive",
    "claude --no-interactive",
  ];
  for (const command of warn) {
    assert.equal(looksNonInteractive(command), true, command);
  }
});

test("looksNonInteractive stays quiet for interactive commands whose flags start with -p or mention print", () => {
  const quiet = [
    "",
    "$SHELL",
    "claude",
    "claude --resume",
    "claude --dangerously-skip-permissions",
    "claude --permission-mode plan",
    "claude --plugin-dir ./plugins",
    "claude --prompt-suggestions",
    'claude --append-system-prompt "print diffs before editing"',
    'claude --append-system-prompt "start the server with npm -p 3000"',
    "claude --append-system-prompt 'never use -p'",
    "claude --model opus-p",
    "claude -P",
    "codex --profile work",
    "aider --pretty",
    "find . -print",
    "npm run print",
    "lp --printer office",
  ];
  for (const command of quiet) {
    assert.equal(looksNonInteractive(command), false, command);
  }
});

test(
  "looksNonInteractive does not show the Claude billing warning for other CLIs' -p flags",
  () => {
    const quiet = [
      "codex -p work",
      "CODEX_HOME=~/.codex-work codex -p work",
      "ssh -p 2222 devbox",
      "npx next dev -p 3000",
      "docker run -it -p 8080:80 node",
    ];
    for (const command of quiet) {
      assert.equal(looksNonInteractive(command), false, command);
    }
  },
);
