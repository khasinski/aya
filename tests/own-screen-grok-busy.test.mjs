// Grok 1.0.46 mid-turn, replayed from a real recording: while it works, the row right above the composer box is a
// braille spinner ending in "[stop]", and the hint row under the box carries "Ctrl+c:cancel".

import { test } from "node:test";
import assert from "node:assert/strict";
import { overRecording, readTimes } from "./helpers/own-screen.mjs";
import { PAST_RECORDING_MS } from "./helpers/timings.mjs";

const { paneBusy } = await import("../dist-electron/vt-state.js");
const { screenIsBusy } = await import("../dist-electron/agent-screen-rules.js");

// The first read that draws the spinner row and the read that draws "Worked for 4.1s".
const TURN_START = 6_346;
const TURN_END = 10_482;

const busyOver = (name, times) => overRecording(name, "grok", times, (id) => paneBusy(id));

test("real screen | Grok busy: paneBusy is true from the spinner row to 'Worked for', false before and after", async () => {
  const times = [...readTimes("grok-busy"), readTimes("grok-busy").at(-1) + PAST_RECORDING_MS];
  const seen = await busyOver("grok-busy", times);
  const wrong = times.filter((t, i) => seen[i] !== (t >= TURN_START && t < TURN_END));
  assert.deepEqual(wrong, [], "times where paneBusy disagrees with the screen");
  assert.ok(seen.filter(Boolean).length > 20, "the turn spans many reads");
});

for (const name of ["grok-idle", "grok-pasted"]) {
  test(`real screen | ${name}: never busy, at any read or after the last`, async () => {
    const times = [...readTimes(name), readTimes(name).at(-1) + PAST_RECORDING_MS];
    assert.deepEqual((await busyOver(name, times)).filter(Boolean), []);
  });
}

// Either marker alone is enough, a quote of one in the transcript is not.
const BOX = [
  "  ╭" + "─".repeat(60) + "╮",
  "  │ ❯" + " ".repeat(57) + "│",
  "  ╰" + "─".repeat(25) + " Grok 4.7 (medium) · always-approve ─╯",
];
const SPINNER = "   ⠦ Responding… 0.6s                                3.1s ⇣1.98k [stop]";
const BUSY_HINT = "  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts";
const IDLE_HINT = "  Shift+Tab:mode  │  Ctrl+x:shortcuts";
const DRAFT_HINT = "  Enter:send  │  Opt+Enter:newline  │  Ctrl+x:shortcuts";
const PROMPT = "     ❯ Write the numbers from 1 to 60.";

// [label, rows, agent, busy]
const ROWS = [
  ["spinner row and cancel hint", [PROMPT, SPINNER, ...BOX, BUSY_HINT], "grok", true],
  ["spinner row, hint row hidden (an overlay)", [PROMPT, SPINNER, ...BOX], "grok", true],
  ["cancel hint, spinner row not drawn yet", [PROMPT, ...BOX, BUSY_HINT], "grok", true],
  ["'Waiting for response' spinner row", [PROMPT, "   ⠙ Waiting for response… 0.1s        0.2s ⇣1.82k [stop]", ...BOX, IDLE_HINT], "grok", true],
  ["a finished turn", [PROMPT, "     Worked for 4.1s", ...BOX, IDLE_HINT], "grok", false],
  ["an idle composer with a draft", [PROMPT, ...BOX, DRAFT_HINT], "grok", false],
  ["a '[stop]' spinner row quoted in the transcript, not above the box", [SPINNER, "     done", ...BOX, IDLE_HINT], "grok", false],
  ["'Ctrl+c:cancel' quoted in the transcript, not the hint row", [PROMPT, "     press Ctrl+c:cancel to stop", ...BOX, IDLE_HINT], "grok", false],
  ["a '[stop]' row without a spinner glyph", [PROMPT, "     see the [stop]", ...BOX, IDLE_HINT], "grok", false],
  ["a bullet row ending in '[stop]' right above the box", [PROMPT, "   • then press [stop]", ...BOX, IDLE_HINT], "grok", false],
  ["braille art without '[stop]' right above the box", [PROMPT, "   ⣿ ⣿⣿ ⣿", ...BOX, IDLE_HINT], "grok", false],
  ["a spinner quoted mid-row right above the box", [PROMPT, "     it showed ⠙ Responding… [stop]", ...BOX, IDLE_HINT], "grok", false],
  ["the busy screen on a Claude pane is not Grok's marker", [PROMPT, SPINNER, ...BOX, BUSY_HINT], "claude", false],
  ["the busy screen on an unknown agent", [PROMPT, SPINNER, ...BOX, BUSY_HINT], undefined, false],
];
for (const [label, rows, agent, busy] of ROWS) {
  test(`screenIsBusy | Grok | ${label}`, () => assert.equal(screenIsBusy(rows, agent), busy));
}
