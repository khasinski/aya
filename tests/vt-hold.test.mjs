// A team message must not be typed where Enter would do something else: an
// approval prompt, the user's half-typed text, or a plain shell. Screens here
// mirror what real Claude, Codex and Grok drew (recorded 2026-09-28).

import { test } from "node:test";
import assert from "node:assert/strict";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const RULE = "─".repeat(60);
const settle = () => new Promise((r) => setTimeout(r, 30));

async function hold(screen, { agent = "claude", shell = false } = {}) {
  openVtPane("h", 80, 24, () => {}, agent, shell);
  try {
    writeVtPane("h", screen.join("\r\n"));
    await settle();
    return paneHold("h");
  } finally {
    closeVtPane("h");
  }
}

test("claude: the dim placeholder is not the user's text", async () => {
  assert.equal(await hold([RULE, DIM('❯ Try "edit <filepath> to..."'), RULE, "  ? for shortcuts"]), null);
});

test("claude: half-typed text in the composer holds delivery", async () => {
  assert.match(await hold([RULE, "❯ half typed text", RULE, "  ? for shortcuts"]), /typing/);
});

test("claude: an old message in the transcript above an empty composer does not hold", async () => {
  assert.equal(await hold(["❯ Run the tests", "", "● Done.", RULE, "❯ ", RULE, "  ? for shortcuts"]), null);
});

test("claude: the composer's own border characters are not text", async () => {
  assert.equal(await hold(["❯ " + "─".repeat(40), "  ? for shortcuts"]), null);
});

test("codex: placeholder is dim, typed text is not", async () => {
  assert.equal(await hold([DIM("› Ask Codex to do anything"), "  GPT-6 medium"], { agent: "codex" }), null);
  assert.match(await hold(["› half typed text", "  GPT-6 medium"], { agent: "codex" }), /typing/);
});

test("grok: text inside the boxed composer holds, an empty box does not", async () => {
  const box = (inner) => ["╭" + RULE + "╮", `│ ❯ ${inner.padEnd(56)} │`, "╰" + RULE + "╯"];
  assert.match(await hold(box("half typed text"), { agent: "grok" }), /typing/);
  assert.equal(await hold(box(""), { agent: "grok" }), null);
});

test("an approval prompt holds delivery", async () => {
  assert.match(
    await hold(["Do you want to proceed?", "❯ 1. Yes", "  2. No"]),
    /approval/,
  );
});

test("opencode: a transcript that quotes a dialog's wording does not hold an idle pane", async () => {
  // Our tester (OpenCode, generic rules) quoted a made-up trust-dialog title in
  // its report; a rule on that wording held its pane as an approval prompt.
  const screen = [
    "  The fixture used the title \"Do you trust the files in this folder?\" with ❯ 1. No, exit.",
    "",
    "┃  Ask anything... \"Fix a TODO in the codebase\"",
    "┃  Build · Big Pickle OpenCode Zen",
  ];
  assert.equal(await hold(screen, { agent: "opencode" }), null);
});

test("claude: the real startup trust dialog (unboxed, unnumbered) holds as a prompt, not as typed text", async () => {
  const dialog = [
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
  ];
  const reason = await hold(dialog);
  assert.doesNotMatch(reason, /typing/, `paneHold said: ${JSON.stringify(reason)}`);
  assert.match(reason, /prompt/, `paneHold said: ${JSON.stringify(reason)}`);
});

// A numbered menu is a live choice waiting for an answer, in every agent's
// composer area. No rule's wording covers it, so paneHold must still hold it -
// and must say so with a reason that is not "the user is typing". One test per
// agent, so one broken agent cannot hide behind another's failure.

test("a numbered choice holds delivery: claude", async () => {
  const reason = await hold(["❯ ", "", "● Pick one", "❯ 1. Alpha", "  2. Beta"]);
  assert.ok(reason, "a numbered choice over an empty composer must hold delivery");
  assert.doesNotMatch(reason, /typing/, `paneHold said: ${JSON.stringify(reason)}`);
});

test("a numbered choice holds delivery: codex", async () => {
  const reason = await hold(
    ["› ", "", "● Pick one", "❯ 1. Alpha", "  2. Beta", "  send esc ctrl newline to interrupt"],
    { agent: "codex" },
  );
  assert.ok(reason, "a numbered choice in codex must hold delivery");
  assert.doesNotMatch(reason, /typing/, `paneHold said: ${JSON.stringify(reason)}`);
});

test("a numbered choice drawn with Codex's own chevron, or numbered with a parenthesis, holds", async () => {
  for (const [row, agent] of [["› 1. Alpha", "codex"], ["❯ 1) Alpha", "claude"], ["› 2) Beta", "codex"]]) {
    const reason = await hold(["● Pick one", row, "  another option"], { agent });
    assert.equal(reason, "shows a numbered choice", `${agent} ${row}`);
  }
});

test("a numbered choice holds delivery: grok, boxed", async () => {
  const reason = await hold(
    [
      "╭" + RULE + "╮",
      "│ " + "❯ 1. Alpha".padEnd(58) + " │",
      "│ " + "  2. Beta".padEnd(58) + " │",
      "╰" + RULE + "╯",
    ],
    { agent: "grok" },
  );
  assert.ok(reason, "a boxed numbered choice in grok must hold delivery");
  assert.doesNotMatch(reason, /typing/, `paneHold said: ${JSON.stringify(reason)}`);
});

test("a numbered choice is not mistaken for the transcript row above it", async () => {
  const menu = ["● Pick one", "❯ 1. Alpha", "  2. Beta"];
  // The same live menu with and without an old composer line far above it. The
  // reason can only stay equal if that line is NOT what got claimed as a draft.
  const withTranscript = await hold(["❯ Run the tests", "", "● Done.", ...menu]);
  const withoutTranscript = await hold(["❯ ", "", ...menu]);
  assert.doesNotMatch(withTranscript, /typing/, `paneHold said: ${JSON.stringify(withTranscript)}`);
  assert.equal(
    withTranscript,
    withoutTranscript,
    `a row ABOVE the live menu changed the reason: ${JSON.stringify(withTranscript)} vs ${JSON.stringify(withoutTranscript)}`,
  );
});

test("a shell pane always holds delivery", async () => {
  assert.match(await hold(["user@host ~ %"], { agent: undefined, shell: true }), /shell/);
});

test("a pane that exited or never started is held: typing into it would fail", async () => {
  assert.match(paneHold("never-opened"), /not running/);
  openVtPane("gone", 80, 24, () => {}, "claude", false);
  closeVtPane("gone");
  assert.match(paneHold("gone"), /not running/);
});

test("an agent that has not drawn its composer yet is still starting up; once seen, it stays known", async () => {
  // Measured: Claude drew its composer after about 1 s, Codex after 0.5 s; text
  // typed before that goes nowhere.
  openVtPane("boot", 80, 24, () => {}, "claude", false);
  try {
    writeVtPane("boot", " ✻ Welcome to Claude Code\r\n");
    await settle();
    assert.match(paneHold("boot"), /starting up/);
    writeVtPane("boot", `${RULE}\r\n${DIM('❯ Try "edit <filepath> to..."')}\r\n${RULE}\r\n`);
    await settle();
    assert.equal(paneHold("boot"), null);
    writeVtPane("boot", "\x1b[2J\x1b[H⏺ a long answer that pushed the composer off screen\r\n");
    await settle();
    assert.equal(paneHold("boot"), null);
  } finally {
    closeVtPane("boot");
  }
  assert.equal(await hold(["┃  Ask anything"], { agent: "opencode" }), null, "no composer rule for opencode: never 'starting'");
});
