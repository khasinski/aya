// Agent-preset helpers. These drive whether a restored terminal silently loses
// its agent conversation: the runtime default for autoResume MUST match what the
// Settings UI shows (default ON for claude/codex), and the appended flag must be
// the "continue latest" form (--continue / resume --last), not a bare picker.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferAgent,
  effectiveAgent,
  isAgentPreset,
  effectiveAutoResume,
  resumeArg,
  commandHasResumeFlag,
  commandWithAutoResume,
} from "../dist-test/agentPreset.js";

const preset = (over) => ({
  id: "p",
  name: "P",
  icon: "x",
  color: "",
  command: "echo hi",
  ...over,
});

test("inferAgent classifies by command when agent field is absent", () => {
  assert.equal(inferAgent({ command: "claude --chrome" }), "claude");
  assert.equal(inferAgent({ command: 'CLAUDE_CONFIG_DIR="$HOME/.c" claude' }), "claude");
  assert.equal(inferAgent({ command: "codex" }), "codex");
  assert.equal(inferAgent({ command: 'CODEX_HOME="$HOME/.x" codex resume' }), "codex");
  assert.equal(inferAgent({ command: "vim" }), "custom");
  // Substring must not false-match (e.g. a script literally named claudette).
  assert.equal(inferAgent({ command: "claudette" }), "custom");
});

test("effectiveAgent prefers the explicit field over inference", () => {
  assert.equal(effectiveAgent(preset({ agent: "custom", command: "claude" })), "custom");
  assert.equal(effectiveAgent(preset({ command: "claude" })), "claude");
});

test("isAgentPreset is true for claude/codex (explicit or inferred)", () => {
  assert.equal(isAgentPreset(preset({ command: "claude" })), true);
  assert.equal(isAgentPreset(preset({ command: "codex" })), true);
  assert.equal(isAgentPreset(preset({ command: "echo hi" })), false);
  assert.equal(isAgentPreset(preset({ agent: "custom", command: "claude" })), false);
});

test("effectiveAutoResume defaults ON for agent presets, OFF for others", () => {
  // The bug: a claude preset that predates the autoResume field (no key) must
  // still default to resuming, matching the Settings UI (?? isAgent).
  assert.equal(effectiveAutoResume(preset({ command: "claude" })), true);
  assert.equal(effectiveAutoResume(preset({ command: "echo hi" })), false);
});

test("effectiveAutoResume honors an explicit false (deliberate opt-out)", () => {
  assert.equal(effectiveAutoResume(preset({ command: "claude", autoResume: false })), false);
  // ?? must not override a real false.
  assert.equal(effectiveAutoResume(preset({ command: "claude", autoResume: true })), true);
});

test("resumeArg continues the latest session, not a picker", () => {
  assert.equal(resumeArg(preset({ command: "claude" })), "--continue");
  assert.equal(resumeArg(preset({ command: "codex" })), "resume --last");
});

test("commandHasResumeFlag detects an existing resume/continue flag", () => {
  assert.equal(commandHasResumeFlag(preset({ command: "claude -c" }), "claude -c"), true);
  assert.equal(commandHasResumeFlag(preset({ command: "claude --continue" }), "claude --continue"), true);
  assert.equal(commandHasResumeFlag(preset({ command: "claude --resume" }), "claude --resume"), true);
  assert.equal(commandHasResumeFlag(preset({ command: "claude" }), "claude"), false);
  assert.equal(commandHasResumeFlag(preset({ command: "codex resume" }), "codex resume"), true);
  assert.equal(commandHasResumeFlag(preset({ command: "codex" }), "codex"), false);
  // Substring guard: "--continued" or "presume" must not match.
  assert.equal(commandHasResumeFlag(preset({ command: "claude --continued" }), "claude --continued"), false);
});

test("commandWithAutoResume appends --continue for a restored agent preset", () => {
  assert.equal(
    commandWithAutoResume(preset({ command: "claude --chrome" }), true),
    "claude --chrome --continue",
  );
  assert.equal(
    commandWithAutoResume(preset({ command: "codex --yolo" }), true),
    "codex --yolo resume --last",
  );
});

test("commandWithAutoResume does NOT append for a fresh (non-restored) terminal", () => {
  assert.equal(commandWithAutoResume(preset({ command: "claude" }), false), "claude");
  assert.equal(commandWithAutoResume(preset({ command: "claude" }), undefined), "claude");
});

test("commandWithAutoResume does NOT append when autoResume is off", () => {
  // Non-agent preset (default off).
  assert.equal(commandWithAutoResume(preset({ command: "echo hi" }), true), "echo hi");
  // Agent preset with explicit opt-out.
  assert.equal(
    commandWithAutoResume(preset({ command: "claude", autoResume: false }), true),
    "claude",
  );
});

test("commandWithAutoResume does NOT double-add when a resume flag is present", () => {
  assert.equal(commandWithAutoResume(preset({ command: "claude -c --chrome" }), true), "claude -c --chrome");
  assert.equal(commandWithAutoResume(preset({ command: "codex resume" }), true), "codex resume");
});

test("commandWithAutoResume returns the original command verbatim when skipped", () => {
  // Empty command is returned as-is (not trimmed) so callers see no surprise.
  assert.equal(commandWithAutoResume(preset({ command: "   " }), true), "   ");
});

// --- pinned resume-arg vocabulary (cross-checked against its own detector) ---
import {
  CODEX_RESUME_ARG,
  CLAUDE_RESUME_ARG,
} from "../dist-test/agentPreset.js";
import { PRESET_ID_CODEX, PRESET_ID_GEMINI } from "../dist-test/preset-ids.js";
import { DEFAULT_PRESETS } from "../dist-electron/presets.js";

test("resume args are the pinned CLI vocabulary", () => {
  assert.equal(CODEX_RESUME_ARG, "resume --last");
  assert.equal(CLAUDE_RESUME_ARG, "--continue");
});

test("commandHasResumeFlag recognizes exactly the args resumeArg appends", () => {
  // If the arg and its detector ever drift apart, a restored tab would either
  // double-append the flag or never resume - the bug the module guards against.
  const claude = { id: "claude", name: "c", icon: "", color: "", command: "claude" };
  const codex = { id: "codex", name: "x", icon: "", color: "", command: "codex" };
  assert.equal(commandHasResumeFlag(claude, `claude ${CLAUDE_RESUME_ARG}`), true);
  assert.equal(commandHasResumeFlag(codex, `codex ${CODEX_RESUME_ARG}`), true);
  assert.equal(commandHasResumeFlag(claude, "claude"), false);
  assert.equal(commandHasResumeFlag(codex, "codex"), false);
});

test("behavior-keyed preset ids match the electron built-ins (cross-boundary tripwire)", () => {
  const ids = DEFAULT_PRESETS.map((p) => p.id);
  assert.ok(ids.includes(PRESET_ID_CODEX), "codex built-in id drifted from PRESET_ID_CODEX");
  // gemini is intentionally NOT a built-in - it matches a user-named preset.
  assert.equal(ids.includes(PRESET_ID_GEMINI), false);
  assert.equal(PRESET_ID_GEMINI, "gemini");
});
