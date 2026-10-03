import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateScreen } from "../dist-electron/agent-screen-rules.js";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

// paneHold waits for xterm's write callback before reading; no parser sleep is needed.
import { fixture as vtFixture } from "./helpers/vt-screens.mjs";

const fixture = (name) => vtFixture(`approval-screens/${name}`);
const RULE = "─".repeat(100);
const FOOTER = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
// The cursor is an inverse cell.
const composer = (typed = "") => [RULE, `❯ ${typed}\x1b[7m \x1b[27m`, RULE, FOOTER];
const say = (...lines) => lines.map((l) => `⏺ ${l}`);
const screen = (...parts) => parts.flat();
const clearScreen = "\x1b[2J\x1b[H";

async function holds(agent, ...screens) {
  openVtPane("t", 140, 40, () => {}, agent, false);
  try {
    const out = [];
    for (const rows of screens) {
      writeVtPane("t", clearScreen + rows.join("\r\n"));
      out.push(await paneHold("t"));
    }
    return out;
  } finally {
    closeVtPane("t");
  }
}

const APPROVAL = "shows an approval prompt";
const CHOICE = "shows a numbered choice";
// Synthetic - to record: a Claude approval of a non-aya command.
const GIT = fixture("synthetic-claude-git-status.txt");
const TRUST = [
  "Accessing workspace:",
  "",
  " /Users/dev/proj",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to cancel",
];

// Sentences an agent writes in its answer that match a prompt rule of the generic set.
const TRANSCRIPT_TEXT = [
  "I'm waiting for approval before starting titleCase.",
  "Waiting for your input on the next step.",
  "Do you want me to continue with titleCase?",
  "Approve this change and I will go on.",
  "Press enter to continue is what the old CLI said.",
];

test("the live screen (answer says waiting for approval, empty composer) is free", async () => {
  // `aya pane read` drops the blank cursor cell the live composer row ends in; put it back.
  const rows = fixture("claude-idle-transcript-waiting-for-approval.txt").map((row) => (row === "❯" ? "❯ \x1b[7m \x1b[27m" : row));
  assert.deepEqual(await holds("claude", rows), [null]);
});

for (const text of TRANSCRIPT_TEXT) {
  test(`claude: "${text}" in the transcript above an empty composer is free`, async () => {
    assert.deepEqual(await holds("claude", screen(say(text), composer())), [null]);
    assert.equal(evaluateScreen(screen(say(text), composer()), "claude"), "clear");
  });

  test(`claude: "${text}" above a draft holds as a draft, not as an approval`, async () => {
    const [reason] = await holds("claude", screen(say(text), composer("half typed")));
    assert.match(reason, /typing/);
  });
}

// [name, screens in order, expected holds]
const ORDER = [
  ["free, then transcript text, stays free", [composer(), screen(say(TRANSCRIPT_TEXT[0]), composer())], [null, null]],
  ["transcript text, then a real prompt, holds", [screen(say(TRANSCRIPT_TEXT[0]), composer()), GIT], [null, APPROVAL]],
  ["real prompt, then answered with the transcript text left behind, is free", [GIT, screen(say(TRANSCRIPT_TEXT[0]), composer())], [APPROVAL, null]],
  ["real prompt that quotes the transcript sentence still holds", [screen(say(TRANSCRIPT_TEXT[0]), GIT)], [APPROVAL]],
  ["trust dialog holds, then the free composer", [TRUST, composer()], [APPROVAL, null]],
  ["a ruled dialog whose selected row is numbered is a prompt, not a composer", [[ "Do you want to proceed?", RULE, "❯ 1. Yes", RULE]], [APPROVAL]],
  ["a y/n question right under a bare composer holds", [screen(say(TRANSCRIPT_TEXT[0]), composer().slice(0, 3), ["Run the migration now? [y/n]"])], [APPROVAL]],
  ["a y/n question under the composer and its footer holds", [screen(say(TRANSCRIPT_TEXT[0]), composer(), ["Run the migration now? [y/n]"])], [APPROVAL]],
  ["a dialog drawn under the composer and its footer holds", [screen(say("done"), composer(), GIT)], [APPROVAL]],
  ["a numbered choice below transcript text holds", [screen(say("Pick one of the two."), ["❯ 1. Alpha", "  2. Beta"])], [CHOICE]],
];

for (const [name, screens, expected] of ORDER) {
  test(`claude: ${name}`, async () => {
    assert.deepEqual(await holds("claude", ...screens), expected);
  });
}

test("claude: a real prompt with allow once / always wording still holds", async () => {
  const rows = ["Allow Claude to run: git push?", " ❯ 1. Allow once", "   2. Always allow", "   3. Deny"];
  const [reason] = await holds("claude", rows);
  assert.ok(reason !== null);
});

test("claude: the real prompt wording is waiting at the evaluateScreen level", () => {
  assert.equal(evaluateScreen(GIT, "claude"), "waiting");
  assert.equal(evaluateScreen(screen(say(TRANSCRIPT_TEXT[0]), GIT), "claude"), "waiting");
});

test("claude: our own pasted text in the composer under transcript wording is free (the blanked row stays a composer)", async () => {
  const pasted = "APPROVED: truncate. You may start titleCase.";
  openVtPane("t", 140, 40, () => {}, "claude", false);
  try {
    writeVtPane("t", clearScreen + screen(say(TRANSCRIPT_TEXT[0]), composer(pasted)).join("\r\n"));
    assert.equal(await paneHold("t", pasted), null);
  } finally {
    closeVtPane("t");
  }
});
