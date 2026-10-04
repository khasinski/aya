// Not recorded: Grok's other modes (they only relabel the box), Grok's permission prompt (worded from the
// grok 1.0.46 binary's strings), and the rows a Claude statusLine adds under its composer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateScreen } from "../dist-electron/agent-screen-rules.js";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

// paneHold waits for xterm's write callback before reading; no parser sleep is needed.
import { HOLD_APPROVAL, HOLD_DRAFT } from "../dist-electron/pane-holds.js";

const ayaHome = mkdtempSync(join(tmpdir(), "aya-false-hold-"));
process.env.AYA_HOME = ayaHome;
test.after(() => rmSync(ayaHome, { recursive: true, force: true }));
const { recordAgentStatus, agentWaitingSince, noteUserAnswer, __resetAgentStatusForTests } = await import("../dist-electron/agent-status.js");

const read = (...p) => readFileSync(join(process.cwd(), "tests", "fixtures", ...p), "utf8").replace(/\n+$/, "").split("\n");
const clearScreen = "\x1b[2J\x1b[H";

async function holdsOver(agent, screens, visit = (id) => paneHold(id)) {
  const id = `fb-${Math.random()}`;
  openVtPane(id, 160, 45, () => {}, agent, false);
  try {
    const out = [];
    for (const rows of screens) {
      writeVtPane(id, clearScreen + rows.join("\r\n"));
      out.push(await visit(id));
    }
    return out;
  } finally {
    closeVtPane(id);
  }
}

const QUESTIONS = ["Do you want me to continue with titleCase?", "I'm waiting for approval before starting titleCase.", "Approve this change and I will go on."];

const GROK_IDLE = read("grok-screens", "idle-after-answer.txt");
const GROK_DRAFT = read("grok-screens", "draft-in-composer.txt");
const box = (screen) => screen.findIndex((row) => row.trimStart().startsWith("╭"));
const inMode = (rows, mode) => rows.map((row) => row.replace("always-approve", mode));
const grokSaid = (screen, text, mode) => inMode([...screen.slice(0, box(screen) - 2), `     ${text}`, "", ...screen.slice(box(screen))], mode);
const grokAsks = (mode) =>
  inMode([...GROK_IDLE.slice(0, box(GROK_IDLE) - 2), "     Allow Execute?", "     $ git push origin main", "   ❯ Yes, allow once", "     Yes, and don't ask again for bash commands", "     No, and tell Grok what to do differently", "", ...GROK_IDLE.slice(box(GROK_IDLE))], mode);
const GROK_MODES = ["always-approve", "default", "plan", "auto"];

for (const mode of GROK_MODES) {
  for (const text of QUESTIONS) {
    test(`B-1 grok ${mode}: "${text}" above its empty composer is free`, async () => {
      assert.equal(evaluateScreen(grokSaid(GROK_IDLE, text, mode), "grok"), "clear");
      assert.deepEqual(await holdsOver("grok", [grokSaid(GROK_IDLE, text, mode)]), [null]);
    });
  }
  test(`B-1 grok ${mode}: the same text above a draft holds as a draft`, async () => {
    assert.deepEqual(await holdsOver("grok", [grokSaid(GROK_DRAFT, QUESTIONS[0], mode)]), [HOLD_DRAFT]);
  });
  test(`B-1 grok ${mode}: free, then its permission prompt, then answered: free, held, free`, async () => {
    assert.deepEqual(await holdsOver("grok", [grokSaid(GROK_IDLE, QUESTIONS[0], mode), grokAsks(mode), grokSaid(GROK_IDLE, "Pushed.", mode)]), [null, HOLD_APPROVAL, null]);
  });
}

test("B-1 grok: a screen without its composer box (an overlay, a dialog of its own) is read as before", () => {
  const noBox = grokSaid(GROK_IDLE, QUESTIONS[0], "default").filter((row) => !/[╭╰]/.test(row));
  assert.equal(evaluateScreen(noBox, "grok"), "waiting");
});

// A focused empty composer paints the cursor as an inverse cell.
const CLAUDE_IDLE = read("approval-screens", "claude-idle-transcript-waiting-for-approval.txt").map((row) => (row === "❯" ? "❯ \x1b[7m \x1b[27m" : row));
const claudeSaid = (text, footer) => {
  const top = CLAUDE_IDLE.findIndex((row) => /^─{8,}/.test(row));
  return [...CLAUDE_IDLE.slice(0, top - 2), `  ${text}`, "", ...CLAUDE_IDLE.slice(top, top + 3), ...footer];
};
const MODE_ROW = CLAUDE_IDLE.at(-1);
const STATUS = "  Opus 5.5 · ctx 41% · main";
const FOOTERS = [
  ["no row under it", []],
  ["its mode row", [MODE_ROW]],
  ["mode row and a statusLine", [MODE_ROW, STATUS]],
  ["a statusLine, then the mode row", [STATUS, MODE_ROW]],
  ["a two-row statusLine and the mode row", [STATUS, "  ~/Projects/demo · 3 files changed", MODE_ROW]],
];
for (const [name, footer] of FOOTERS) {
  for (const text of QUESTIONS) {
    test(`B-2 claude, ${name}: "${text}" above the empty composer is free`, async () => {
      assert.equal(evaluateScreen(claudeSaid(text, footer), "claude"), "clear");
      assert.deepEqual(await holdsOver("claude", [claudeSaid(text, footer)]), [null]);
    });
  }
}

const UNDER = [
  ["a question under the composer", [MODE_ROW, STATUS, "Run the migration now? [y/n]"]],
  ["a picker under the composer", [MODE_ROW, "  ❯ Opus 5.5", "    Sonnet 5.5", "  Enter to confirm · Esc to cancel"]],
  ["a short picker, within the rows a footer may have", ["  ❯ Opus 5.5", "  Enter to confirm · Esc to cancel"]],
  ["a numbered choice under the composer", [MODE_ROW, "  ❯ 1. Yes", "    2. No"]],
];
for (const [name, footer] of UNDER) {
  test(`B-2 claude: ${name} still holds`, async () => {
    const [hold] = await holdsOver("claude", [claudeSaid(QUESTIONS[0], footer)]);
    assert.ok(hold && hold !== HOLD_DRAFT, `held as a dialog, got ${hold}`);
  });
}

const ANSWERED = [
  ["claude with a statusLine", "claude", (text) => claudeSaid(text, [MODE_ROW, STATUS])],
  ["grok in default mode", "grok", (text) => grokSaid(GROK_IDLE, text, "default")],
];
for (const [name, agent, screen] of ANSWERED) {
  test(`B-3 ${name}: the user's Enter under "Do you want me to wait?" answers the lead's question`, async () => {
    __resetAgentStatusForTests();
    const [answered] = await holdsOver(agent, [screen("Do you want me to wait, or use the test one?")], async (id) => {
      recordAgentStatus(id, "waiting", Date.now(), "need the staging password");
      const update = await noteUserAnswer(id, "use the test one\r", () => paneHold(id));
      return { update, still: agentWaitingSince(id) };
    });
    assert.equal(answered.update?.level, "clear");
    assert.equal(answered.still, null);
    __resetAgentStatusForTests();
  });
}
