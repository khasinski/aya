// A team message must not be typed where Enter would do something else. The screens
// mirror what real Claude, Codex, Grok and OpenCode drew.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

// paneHold waits for xterm's write callback before reading; no parser sleep is needed.

const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const RULE = "─".repeat(60);

let seq = 0;

async function hold(screen, { agent = "claude", shell = false } = {}) {
  const id = `hold-${++seq}`;
  openVtPane(id, 80, 24, () => {}, agent, shell);
  try {
    writeVtPane(id, screen.join("\r\n"));
    return await paneHold(id);
  } finally {
    closeVtPane(id);
  }
}

// The helpers and dialog cases use case-local pane ids. Keep the real parser
// and background-scan waits, while independent panes run together.
describe("holds on independent panes", { concurrency: 8 }, () => {
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

  test("a pasted-content placeholder is a draft: claude and codex hold", async () => {
    assert.match(await hold([RULE, "❯ [Pasted text #1 +12 lines]", RULE, "  ? for shortcuts"]), /typing/);
    assert.match(await hold(["› [Pasted Content 1204 chars]", "  GPT-6 medium"], { agent: "codex" }), /typing/);
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

  // No rule's wording covers a numbered menu, so paneHold must hold it on its own, and not as
  // "typing". One test per agent, so one broken agent cannot hide behind another's failure.

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
    assert.match(await paneHold("never-opened"), /not running/);
    openVtPane("gone", 80, 24, () => {}, "claude", false);
    closeVtPane("gone");
    assert.match(await paneHold("gone"), /not running/);
  });

  test("an agent that has not drawn its composer yet is still starting up; once seen, it stays known", async () => {
    // Measured: Claude drew its composer after about 1 s, Codex after 0.5 s; text
    // typed before that goes nowhere.
    openVtPane("boot", 80, 24, () => {}, "claude", false);
    try {
      writeVtPane("boot", " ✻ Welcome to Claude Code\r\n");
      assert.match(await paneHold("boot"), /starting up/);
      writeVtPane("boot", `${RULE}\r\n${DIM('❯ Try "edit <filepath> to..."')}\r\n${RULE}\r\n`);
      assert.equal(await paneHold("boot"), null);
      writeVtPane("boot", "\x1b[2J\x1b[H⏺ a long answer that pushed the composer off screen\r\n");
      assert.equal(await paneHold("boot"), null);
    } finally {
      closeVtPane("boot");
    }
    assert.equal(await hold(["┃  Ask anything"], { agent: "opencode" }), null, "opencode's bar is its composer");
  });

  test("every agent with a known composer is starting up until it draws one", async () => {
    for (const agent of ["claude", "codex", "grok"]) {
      assert.match(await hold([" loading..."], { agent }), /starting up/, agent);
    }
  });

  // A numbered dialog (Codex "Folder access", Claude's picker) draws the composer's chevron; once
  // dismissed, the real composer comes 0.5-1 s later and text typed before it goes nowhere.
  const BOXED = (inner) => ["╭" + RULE + "╮", `│ ${inner.padEnd(58)} │`, "╰" + RULE + "╯"].join("\r\n");
  const DIALOGS = {
    claude: "Choose\r\n❯ 1. Dark\r\n  2. Light",
    codex: "Do you trust this folder?\r\n› 1. Yes, continue\r\n  2. No, quit",
    grok: BOXED("❯ 1. Dark"),
  };
  const COMPOSERS = {
    claude: `${RULE}\r\n❯ \r\n${RULE}\r\n  ? for shortcuts`,
    codex: "› \r\n\r\n  GPT-6 medium",
    grok: BOXED("❯ "),
  };

  for (const agent of ["claude", "codex", "grok"]) {
    test(`${agent}: a dismissed numbered dialog is still starting up until the composer is drawn`, async () => {
      const id = `dialog-${++seq}`;
      openVtPane(id, 80, 24, () => {}, agent, false);
      try {
        writeVtPane(id, DIALOGS[agent]);
        // Past the 250 ms scan timer: the background scan must not latch the dialog either.
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(await paneHold(id), "shows a numbered choice");
        writeVtPane(id, "\x1b[2J\x1b[H Loading...");
        assert.match(await paneHold(id), /starting up/);
        writeVtPane(id, `\x1b[2J\x1b[H${COMPOSERS[agent]}`);
        assert.equal(await paneHold(id), null);
      } finally {
        closeVtPane(id);
      }
    });
  }

  test("a composer seen only by the background scan still counts as started", async () => {
    openVtPane("scan", 80, 24, () => {}, "claude", false);
    try {
      writeVtPane("scan", `${RULE}\r\n❯ \r\n${RULE}\r\n`);
      // Set after the 250 ms scan timer, so it fires after the scan however late both run.
      await new Promise((r) => setTimeout(r, 400));
      writeVtPane("scan", "\x1b[2J\x1b[H⏺ a long answer that pushed the composer off screen\r\n");
      assert.equal(await paneHold("scan"), null);
    } finally {
      closeVtPane("scan");
    }
  });

  test("claude: a prompt written a moment ago is seen without waiting for the parser", async () => {
    openVtPane("fresh", 80, 24, () => {}, "claude", false);
    try {
      writeVtPane("fresh", [RULE, "❯ ", RULE, "  ? for shortcuts"].join("\r\n"));
      assert.equal(await paneHold("fresh"), null);
      writeVtPane("fresh", "\x1b[2J\x1b[H" + ["Do you want to proceed?", "❯ 1. Yes", "  2. No", "Esc to cancel"].join("\r\n"));
      assert.match(String(await paneHold("fresh")), /prompt|numbered/);
    } finally {
      closeVtPane("fresh");
    }
  });

  // The unnumbered trust dialog's "❯ No, exit" reads as a draft row; the background scan must not
  // take it for the composer, or the window after dismissal is free and the text is lost.
  test("claude: a dismissed unnumbered trust dialog is still starting up after the background scan saw it", async () => {
    openVtPane("trust", 80, 24, () => {}, "claude", false);
    try {
      writeVtPane("trust", [" Quick safety check: Is this a project you trust?", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"].join("\r\n"));
      await new Promise((r) => setTimeout(r, 400));
      writeVtPane("trust", "\x1b[2J\x1b[H Loading...");
      assert.match(String(await paneHold("trust")), /starting up/);
    } finally {
      closeVtPane("trust");
    }
  });

  test("claude: a real composer whose draft contains a chevron still latches in the background scan", async () => {
    openVtPane("chev", 80, 24, () => {}, "claude", false);
    try {
      writeVtPane("chev", [RULE, "❯ see ❯ this", RULE, "  ? for shortcuts"].join("\r\n"));
      await new Promise((r) => setTimeout(r, 400));
      writeVtPane("chev", "\x1b[2J\x1b[H⏺ long answer\r\n");
      assert.equal(await paneHold("chev"), null);
    } finally {
      closeVtPane("chev");
    }
  });

  // Screens below: the text Aya pasted is in the composer, and only those rows are not a prompt.
  async function holdPasted(screen, pasted, agent = "opencode") {
    const id = `pasted-${++seq}`;
    openVtPane(id, 80, 24, () => {}, agent, false);
    try {
      writeVtPane(id, screen.join("\r\n"));
      return await paneHold(id, pasted);
    } finally {
      closeVtPane(id);
    }
  }

  test("pasted mask: an approval row directly above the pasted rows still holds", async () => {
    assert.match(await holdPasted(["Do you want to proceed?", "❯ hello there"], "hello there"), /prompt/);
  });

  test("pasted mask: a row that only ends with the pasted text is not masked", async () => {
    assert.match(await holdPasted(["Do you want to proceed? hello there"], "hello there"), /prompt/);
  });

  test("pasted mask: a message also in the transcript is masked in the composer, not above it", async () => {
    const msg = "all done? [y/n]";
    const reason = await holdPasted([`❯ ${msg}`, "● Done.", `❯ ${msg}`], msg, "claude");
    assert.equal(reason, null, "the composer copy is the one masked, and it holds only Aya's own text");
  });

  test("pasted mask: whitespace-only pasted text masks nothing", async () => {
    assert.match(await holdPasted(["Do you want to proceed?", "❯ "], "   "), /prompt/);
  });

  test("pasted mask: a pasted aya command does not make a generic approval an aya approval", async () => {
    const reason = await holdPasted(["Do you want to proceed?", "❯ run aya team send x"], "run aya team send x");
    assert.equal(reason, "shows an approval prompt");
  });

  // Drawn in the gap between paste and Enter, the model picker's selected row reads as a draft,
  // which that check tolerates: only its footer tells it from a composer.
  test("claude: the unnumbered model picker drawn after the paste holds as a prompt", async () => {
    const picker = ["Select model", "", "❯ Default (recommended)", "  Opus", "  Sonnet", "", "Enter to confirm · Esc to exit"];
    assert.match(String(await holdPasted(picker, "hello there", "claude")), /prompt/);
  });

  // Numbered choice wins over "starting up": the dialog needs a person, so the pane is blocked, not one to wait on.
  test("claude: a fresh pane on a rule-less numbered startup dialog says so, not that it is starting up", async () => {
    assert.equal(await hold(["Choose the text style", "❯ 1. Dark", "  2. Light"]), "shows a numbered choice");
  });

  for (const [name, row] of [
    ["a box with a right edge", (m) => `│ ❯ ${m.padEnd(40)} │`],
    ["a heavy box with a right edge", (m) => `┃ ❯ ${m.padEnd(40)} ┃`],
    ["a codex chevron", (m) => `› ${m}`],
    ["a bar with trailing spaces", (m) => `❯ ${m}   `],
  ]) {
    test(`pasted mask: ${name} around the pasted text is stripped before it is compared`, async () => {
      const msg = "Do you want to proceed?";
      const masked = String(await holdPasted([row(msg)], msg));
      assert.doesNotMatch(masked, /prompt|approval/, `our own text is no prompt: ${masked}`);
      assert.match(String(await holdPasted([row(msg)], "something else")), /prompt|approval/, "unmasked, the same row is a prompt");
    });
  }
});
