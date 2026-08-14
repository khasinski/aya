// Per-agent rules for reading a pane's screen. The point of making these
// per-agent is SUPPRESSORS: a generic matcher can only say "this text is on
// screen", which is wrong exactly when the user is scrolling back through a
// transcript that contains old prompts verbatim.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateScreen,
  hasAgentRules,
  rulesForAgent,
} from "../dist-electron/agent-screen-rules.js";

const rows = (...lines) => lines;

// --- prompts ---------------------------------------------------------------

test("an approval prompt near the cursor reads as waiting", () => {
  assert.equal(
    evaluateScreen(rows("Editing src/foo.ts", "Do you want to proceed?"), "claude"),
    "waiting",
  );
});

test("ordinary output reads as clear", () => {
  assert.equal(
    evaluateScreen(rows("Compiling module foo", "Done in 2.1s"), "claude"),
    "clear",
  );
});

test("an empty screen has no opinion", () => {
  // Saying "clear" here would let the screen watcher silence a bell before the
  // pane has rendered anything at all.
  assert.equal(evaluateScreen([], "claude"), null);
});

test("a [y/n] suffix counts only on the final line", () => {
  assert.equal(evaluateScreen(rows("Overwrite file? [y/n]"), undefined), "waiting");
  // The same text buried mid-screen is history, not a live prompt.
  assert.equal(
    evaluateScreen(rows("Overwrite file? [y/n]", "y", "done", "next task"), undefined),
    "clear",
  );
});

test("a prompt far above the cursor falls outside the tail region", () => {
  const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  assert.equal(
    evaluateScreen(["Do you want to proceed?", ...filler], "claude"),
    "clear",
  );
});

// --- suppressors: the reason this is per-agent -----------------------------

test("Claude's transcript view suppresses prompts replayed from history", () => {
  // Scrolling back shows past approvals verbatim. Without a suppressor this
  // reads as a live prompt and the pane looks blocked forever.
  const screen = rows(
    "Showing full transcript (ctrl+r to toggle)",
    "Do you want to proceed?",
    "1. Yes",
  );
  assert.equal(evaluateScreen(screen, "claude"), "clear");
  // The generic rule set has no such knowledge — which is the gap per-agent
  // rules close.
  assert.equal(evaluateScreen(screen, undefined), "waiting");
});

test("Claude's idle composer hint is not a prompt", () => {
  assert.equal(
    evaluateScreen(rows("Do you want to proceed?", "? for shortcuts"), "claude"),
    "clear",
  );
});

test("Codex's composer hint suppresses the same way", () => {
  assert.equal(
    evaluateScreen(
      rows("Do you want me to apply this?", "Esc to interrupt"),
      "codex",
    ),
    "clear",
  );
});

test("a suppressor outranks a prompt no matter the order on screen", () => {
  const promptFirst = rows("Do you want to proceed?", "? for shortcuts");
  const hintFirst = rows("? for shortcuts", "Do you want to proceed?");
  assert.equal(evaluateScreen(promptFirst, "claude"), "clear");
  // The hint only suppresses from the LAST line, so this one is a real prompt.
  assert.equal(evaluateScreen(hintFirst, "claude"), "waiting");
});

// --- rule sets -------------------------------------------------------------

test("agents without their own rules fall back to the generic set", () => {
  assert.equal(hasAgentRules("claude"), true);
  assert.equal(hasAgentRules("codex"), true);
  assert.equal(hasAgentRules("grok"), false);
  assert.equal(hasAgentRules(undefined), false);
  // Falling back must still detect the common prompts, so an unknown CLI is
  // no worse off than before per-agent rules existed.
  assert.equal(evaluateScreen(rows("Do you want to proceed?"), "grok"), "waiting");
});

test("every agent rule set carries at least the generic prompts", () => {
  for (const agent of ["claude", "codex", undefined]) {
    const prompts = rulesForAgent(agent).filter((r) => r.kind === "prompt");
    assert.ok(prompts.length >= 11, `${agent ?? "generic"} lost prompt rules`);
  }
});

test("only agents with real knowledge define suppressors", () => {
  assert.ok(rulesForAgent("claude").some((r) => r.kind === "suppressor"));
  assert.equal(
    rulesForAgent(undefined).some((r) => r.kind === "suppressor"),
    false,
    "a generic suppressor would silence agents we know nothing about",
  );
});
