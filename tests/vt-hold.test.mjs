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

test("a shell pane always holds delivery", async () => {
  assert.match(await hold(["user@host ~ %"], { agent: undefined, shell: true }), /shell/);
});

test("an unknown pane has no opinion", () => {
  assert.equal(paneHold("nope"), null);
});
