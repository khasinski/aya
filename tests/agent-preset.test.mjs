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
  sessionResumeArg,
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

test("the e2e respawn-resume marker preset appends onto tee's operand list", () => {
  // Pins the contract e2e/respawn-resume.spec.ts is built on: this exact
  // command (a) infers as claude, (b) has no token commandHasResumeFlag would
  // read as an existing resume flag (`tee --` must not count), and (c) gets
  // the resume arg appended at the very END of the line, where tee (after its
  // `--`) treats it as a second output file - the spec asserts that file
  // exists. If any of these drift, the e2e goes silently vacuous.
  const command = "CLAUDE_CONFIG_DIR=/tmp/aya-e2e-rr echo run | tee -- respawn-marker.txt";
  const p = preset({ command });
  assert.equal(effectiveAgent(p), "claude");
  assert.equal(commandHasResumeFlag(p, command), false);
  assert.equal(commandWithAutoResume(p, true), `${command} --continue`);
  assert.equal(commandWithAutoResume(p, false), command);
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

// --- multi-agent support --------------------------------------------------
// Beyond claude/codex, agents are classified so their sessions can be resumed
// by id. These CLIs have no verified "continue latest" form, so they must
// resume ONLY when a concrete session id is known — never guess a flag onto
// an ordinary launch.

test("inferAgent classifies the newer agent CLIs by binary", () => {
  assert.equal(inferAgent({ command: "cursor-agent" }), "cursor");
  assert.equal(inferAgent({ command: "copilot" }), "copilot");
  assert.equal(inferAgent({ command: "grok" }), "grok");
  assert.equal(inferAgent({ command: "droid" }), "droid");
  assert.equal(inferAgent({ command: "devin" }), "devin");
  assert.equal(inferAgent({ command: "kimi" }), "kimi");
  assert.equal(inferAgent({ command: "hermes" }), "hermes");
  assert.equal(inferAgent({ command: "qodercli" }), "qodercli");
  assert.equal(inferAgent({ command: "agy" }), "antigravity");
});

test("inferAgent does not match a binary that merely starts with an agent name", () => {
  assert.equal(inferAgent({ command: "grokking" }), "custom");
  assert.equal(inferAgent({ command: "cursor-agentx" }), "custom");
});

test("agents without a continue-latest form append nothing on a bare restore", () => {
  // The dangerous failure would be inventing a flag: it would break every
  // restore of that CLI. No id, no flag.
  for (const command of ["cursor-agent", "grok", "kimi", "agy"]) {
    assert.equal(resumeArg(preset({ command })), null);
    assert.equal(commandWithAutoResume(preset({ command }), true), command);
  }
});

test("a known session id resumes that exact session, per agent syntax", () => {
  assert.equal(
    commandWithAutoResume(preset({ command: "cursor-agent" }), true, "abc123"),
    "cursor-agent --resume abc123",
  );
  assert.equal(
    commandWithAutoResume(preset({ command: "copilot" }), true, "abc123"),
    "copilot --resume=abc123",
  );
  assert.equal(
    commandWithAutoResume(preset({ command: "kimi" }), true, "abc123"),
    "kimi --session abc123",
  );
  assert.equal(
    commandWithAutoResume(preset({ command: "agy" }), true, "abc123"),
    "agy --conversation abc123",
  );
});

test("a session id beats the continue-latest form for claude/codex", () => {
  assert.equal(
    commandWithAutoResume(preset({ command: "claude" }), true, "sess-1"),
    "claude --resume sess-1",
  );
  assert.equal(
    commandWithAutoResume(preset({ command: "codex" }), true, "sess-1"),
    "codex resume sess-1",
  );
});

test("a session id is ignored on a fresh (non-restored) launch", () => {
  assert.equal(
    commandWithAutoResume(preset({ command: "claude" }), false, "sess-1"),
    "claude",
  );
});

test("a blank session id falls back to the continue-latest form", () => {
  assert.equal(
    commandWithAutoResume(preset({ command: "claude" }), true, "   "),
    "claude --continue",
  );
});

test("sessionResumeArg returns null for a custom preset or empty id", () => {
  assert.equal(sessionResumeArg(preset({ command: "vim" }), "abc"), null);
  assert.equal(sessionResumeArg(preset({ command: "claude" }), ""), null);
});

test("an existing resume flag still suppresses the session-id append", () => {
  assert.equal(
    commandWithAutoResume(preset({ command: "kimi --session old" }), true, "new"),
    "kimi --session old",
  );
});

// --- opencode / kilo / pi ---------------------------------------------------
// Unlike the session-id-only agents above, these three were verified against
// the actually-installed CLIs, so they get a real "continue latest" form and
// resume on any restore — no session id needed.

test("opencode, kilo and pi continue their latest session on a bare restore", () => {
  assert.equal(commandWithAutoResume(preset({ command: "opencode" }), true), "opencode --continue");
  assert.equal(commandWithAutoResume(preset({ command: "kilo" }), true), "kilo --continue");
  assert.equal(commandWithAutoResume(preset({ command: "pi" }), true), "pi --continue");
});

test("opencode, kilo and pi resume a specific session when one is known", () => {
  assert.equal(
    commandWithAutoResume(preset({ command: "opencode" }), true, "ses_1"),
    "opencode --session ses_1",
  );
  assert.equal(
    commandWithAutoResume(preset({ command: "kilo" }), true, "ses_1"),
    "kilo --session ses_1",
  );
  // pi's --session takes a path or a partial UUID.
  assert.equal(
    commandWithAutoResume(preset({ command: "pi" }), true, "/tmp/s.jsonl"),
    "pi --session /tmp/s.jsonl",
  );
});

test("pi's interactive picker flag is never what auto-resume appends", () => {
  // `pi --resume` opens a session PICKER and would hang a restored tab waiting
  // for a keypress — the same trap as a bare `claude --resume`.
  for (const command of ["opencode", "kilo", "pi"]) {
    assert.equal(resumeArg(preset({ command })), "--continue");
  }
});

test("an already-flagged opencode-family command is not double-appended", () => {
  for (const command of ["opencode -c", "kilo --continue", "pi --session abc"]) {
    assert.equal(commandWithAutoResume(preset({ command }), true), command);
  }
});

test("opencode-family binaries are matched exactly, not by prefix", () => {
  assert.equal(inferAgent({ command: "opencode" }), "opencode");
  assert.equal(inferAgent({ command: "kilo" }), "kilo");
  assert.equal(inferAgent({ command: "pi" }), "pi");
  // Near-misses must not be swept in.
  assert.equal(inferAgent({ command: "pip install x" }), "custom");
  assert.equal(inferAgent({ command: "kilobyte" }), "custom");
  assert.equal(inferAgent({ command: "opencoder" }), "custom");
});
