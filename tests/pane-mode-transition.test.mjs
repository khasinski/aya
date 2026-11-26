// Terminal ⇄ Conversation as the header and the veil show it (src/pane-mode-transition.ts): which message a second
// request overrides, the switch's timeout, and the veil's resume line.

import { test } from "node:test";
import assert from "node:assert/strict";

// The renderer globals the module touches: the pty bus (a terminal target) and the veil's paint wait.
globalThis.window = { aya: { onPtyEvent: () => () => {} } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const {
  beginPaneModeSwitch, paneModeReady, paneModeState, paneModeSwapped, paneModeSwitching, paneModeTarget, paneModeWarned,
  setPaneModeMessage, setPaneModeResuming, PANE_MODE_FADE_MS, SWITCH_TIMEOUT_MS,
} = await import("../dist-test/pane-mode-transition.js");
const { holdPaneHeaderElement, paneHeaderElement } = await import("../dist-test/components/PaneHeader.js");

const settle = async (t, ms = 0) => { for (let i = 0; i < 5; i++) { t.mock.timers.tick(ms); ms = 0; await Promise.resolve(); } };

test("only a warning about the same switch lets the next request switch past it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A refusal (the agent's prompt on screen): the user answers it, the agent starts its turn, the next click must warn.
  setPaneModeMessage("w", "Answer the agent's prompt in the terminal before switching.");
  assert.equal(paneModeWarned("w", "gui"), false);
  setPaneModeMessage("w", "The agent may still be working. Switch again to stop it and switch anyway.", "gui");
  assert.equal(paneModeWarned("w", "gui"), true);
  assert.equal(paneModeWarned("w", "terminal"), false, "a warning about the other way");
  setPaneModeMessage("w", "The switch took too long. The pane shows where it got to.");
  assert.equal(paneModeWarned("w", "gui"), false, "a failure replaces the warning");
  setPaneModeMessage("w", "The agent may be waiting for an answer. Switch again to switch anyway.", "gui");
  t.mock.timers.tick(8000);
  assert.equal(paneModeWarned("w", "gui"), false, "a warning no longer shown overrides nothing");
});

test("a slow switch times out only counting from the swap, and a late ready takes the timeout's message back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const begun = beginPaneModeSwitch("slow", "gui", true);
  await settle(t, PANE_MODE_FADE_MS);
  await begun;
  // Most of the time goes before the swap: the transcript lookup's fallback scan, stopping the terminal.
  await settle(t, SWITCH_TIMEOUT_MS - 1000);
  paneModeSwapped("slow");
  await settle(t, SWITCH_TIMEOUT_MS - 1000);
  assert.equal(paneModeSwitching("slow"), true);
  assert.equal(paneModeState("slow").message, null);
  // A cold start with MCP servers takes longer still: the veil lifts and says so.
  await settle(t, 1000);
  await settle(t, PANE_MODE_FADE_MS);
  assert.equal(paneModeSwitching("slow"), false);
  assert.match(paneModeState("slow").message, /took too long/);
  // The Conversation connects after all.
  assert.equal(paneModeTarget("slow"), "gui", "the view still reports readiness");
  paneModeReady("slow");
  assert.equal(paneModeState("slow").message, null);
  assert.equal(paneModeTarget("slow"), null);
});

test("leaving a Conversation says whether the terminal resumes only once the agent handed its session over", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const begun = beginPaneModeSwitch("term", "terminal");
  assert.equal(paneModeState("term").transition.detail, "Stopping the conversation");
  await settle(t, PANE_MODE_FADE_MS);
  await begun;
  setPaneModeResuming("term", false);
  assert.equal(paneModeState("term").transition.detail, "Starting a new session");
  setPaneModeResuming("term", true);
  assert.equal(paneModeState("term").transition.detail, "Resuming session");
  paneModeReady("term");
  for (let i = 0; i < 3; i++) await settle(t, PANE_MODE_FADE_MS);
  assert.equal(paneModeSwitching("term"), false);
});

test("a closed pane's header element goes with it; a switch's remount keeps it", async () => {
  const made = [];
  globalThis.document = { createElement: (tag) => { const el = { tag }; made.push(el); return el; } };
  const header = paneHeaderElement("h");
  const releaseTerminal = holdPaneHeaderElement("h");
  // A switch: the terminal's header unmounts and the Conversation's mounts in the same commit.
  releaseTerminal();
  const releaseGui = holdPaneHeaderElement("h");
  await Promise.resolve();
  assert.equal(paneHeaderElement("h"), header);
  releaseGui();
  await Promise.resolve();
  assert.notEqual(paneHeaderElement("h"), header, "the closed pane's element is no longer kept");
  assert.equal(made.length, 2);
});
