// Composers are the recorded ones: Codex 0.158/0.159, OpenCode 1.18.30 (a question replaces its composer),
// Grok 1.0.46 in always-approve mode (its overlays hide the footer).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateScreen } from "../dist-electron/agent-screen-rules.js";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

// paneHold waits for xterm's write callback before reading; no parser sleep is needed.

const read = (...p) => readFileSync(join(process.cwd(), "tests", "fixtures", ...p), "utf8").replace(/\n+$/, "").split("\n");
const clearScreen = "\x1b[2J\x1b[H";

async function holds(agent, ...screens) {
  openVtPane("t", 160, 45, () => {}, agent, false);
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
const DRAFT = /typing/;

const TRANSCRIPT_TEXT = [
  "I'm waiting for approval before starting titleCase.",
  "Waiting for your input on the next step.",
  "Do you want me to continue with titleCase?",
  "Approve this change and I will go on.",
  "Press enter to continue is what the old CLI said.",
];

const CODEX_BUSY = read("busy-codex.screen.txt");
const codexComposer = (typed) => [typed ? `› ${typed}` : "› \x1b[2mAsk Codex to do anything\x1b[22m", CODEX_BUSY.at(-2).replace(/ · ⠼$/, ""), CODEX_BUSY.at(-1)];
const codexSay = (text) => [`• ${text}`, ""];
// Synthetic - to record: a Codex approval of a command other than aya.
const CODEX_DIALOG = read("approval-screens", "synthetic-codex-git-status.txt");

const OC_BUSY = read("busy-opencode.screen.txt");
const ocComposer = (typed) => [
  "  ┃",
  typed ? `  ┃  ${typed}` : "  ┃",
  "  ┃",
  "  ┃  Build · DeepSeek V4 Flash OpenCode Zen · high",
  OC_BUSY.find((row) => row.trimStart().startsWith("╹")),
  "                                                            41.1K (4%) · $0.04  ctrl+p commands    • OpenCode 1.18.30",
];
const ocSay = (text) => [`     ${text}`, ""];
const OC_QUESTION = read("opencode-plan-question.screen.txt");

// The answer's last paragraph is replaced by the sentence.
const GROK_IDLE = read("grok-screens", "idle-after-answer.txt");
const GROK_DRAFT = read("grok-screens", "draft-in-composer.txt");
const GROK_OVERLAY = read("grok-screens", "palette-overlay.txt");
const grokWith = (screen, text) => {
  const box = screen.findIndex((row) => row.trimStart().startsWith("╭"));
  return [...screen.slice(0, box - 2), `     ${text}`, "", ...screen.slice(box)];
};

const AGENTS = [
  { agent: "codex", free: (t) => [...codexSay(t), ...codexComposer()], draft: (t) => [...codexSay(t), ...codexComposer("half typed")], dialog: CODEX_DIALOG },
  { agent: "opencode", free: (t) => [...ocSay(t), ...ocComposer()], draft: (t) => [...ocSay(t), ...ocComposer("half typed")], dialog: OC_QUESTION },
  { agent: "grok", free: (t) => grokWith(GROK_IDLE, t), draft: (t) => grokWith(GROK_DRAFT, t), dialog: null },
];

for (const { agent, free, draft, dialog } of AGENTS) {
  for (const text of TRANSCRIPT_TEXT) {
    test(`${agent}: "${text}" in the transcript above an empty composer is free`, async () => {
      assert.deepEqual(await holds(agent, free(text)), [null]);
      assert.equal(evaluateScreen(free(text), agent), "clear");
    });

    test(`${agent}: "${text}" above a draft holds as a draft, not as an approval`, async () => {
      const [reason] = await holds(agent, draft(text));
      assert.match(reason ?? "", DRAFT);
    });
  }

  if (dialog) {
    // [name, screens in order, expected holds]
    const ORDER = [
      ["free, then transcript text, stays free", [free("done"), free(TRANSCRIPT_TEXT[2])], [null, null]],
      ["transcript text, then its real dialog, holds", [free(TRANSCRIPT_TEXT[2]), dialog], [null, APPROVAL]],
      ["real dialog, then answered with the transcript text left behind, is free", [dialog, free(TRANSCRIPT_TEXT[2])], [APPROVAL, null]],
      ["its real dialog below transcript text holds", [[...(agent === "codex" ? codexSay : ocSay)(TRANSCRIPT_TEXT[0]), ...dialog]], [APPROVAL]],
    ];
    for (const [name, screens, expected] of ORDER) {
      test(`${agent}: ${name}`, async () => {
        assert.deepEqual(await holds(agent, ...screens), expected);
      });
    }
  }

  test(`${agent}: a dialog drawn under the composer and its footer holds`, async () => {
    const [reason] = await holds(agent, [...free("done"), "  Approve this command: git push", "  Press enter to confirm or esc to cancel"]);
    assert.equal(reason, APPROVAL);
  });

  test(`${agent}: a y/n question under the composer holds`, async () => {
    const [reason] = await holds(agent, [...free("done"), "Run the migration now? [y/n]"]);
    assert.equal(reason, APPROVAL);
  });
}

test("codex: a numbered row with the composer's chevron is a dialog, not a composer", () => {
  assert.equal(evaluateScreen([...codexSay(TRANSCRIPT_TEXT[2]), "› 1. Yes, proceed (y)", "  2. No (esc)"], "codex"), "waiting");
});

test("grok: an overlay drawn over the composer hides the footer, so the composer does not clear it", () => {
  const overlaid = grokWith(GROK_OVERLAY, TRANSCRIPT_TEXT[2]);
  assert.equal(evaluateScreen(overlaid, "grok"), evaluateScreen(overlaid, undefined), "read as by the generic rules");
});

test("grok: outside always-approve the composer clears transcript wording too", () => {
  const otherMode = grokWith(GROK_IDLE, TRANSCRIPT_TEXT[2]).map((row) => row.replace("always-approve", "default"));
  assert.equal(evaluateScreen(otherMode, "grok"), "clear");
});

test("opencode: a composer with no agent line (a dialog in its bar) clears nothing", () => {
  const rows = [...ocSay(TRANSCRIPT_TEXT[2]), "  ┃", "  ┃  Allow once   Allow always   Reject", OC_BUSY.find((row) => row.trimStart().startsWith("╹"))];
  assert.equal(evaluateScreen(rows, "opencode"), "waiting");
});

// paneHold(pasted) blanks Aya's own text before it reads the screen; the composer must still count.
const GROK_TYPED = GROK_DRAFT.filter((row) => /^\s*│/.test(row)).map((row) => row.replace(/^\s*│\s*(?:❯\s*)?|\s*│\s*$/g, "")).join(" ");
for (const { agent, draft } of AGENTS) {
  test(`${agent}: our own pasted text in the composer under transcript wording is free`, async () => {
    const pasted = agent === "grok" ? GROK_TYPED : "half typed";
    openVtPane("t", 160, 45, () => {}, agent, false);
    try {
      writeVtPane("t", clearScreen + draft(TRANSCRIPT_TEXT[2]).join("\r\n"));
      assert.equal(await paneHold("t", pasted), null);
      assert.match((await paneHold("t")) ?? "", DRAFT, "without the paste it is a draft");
    } finally {
      closeVtPane("t");
    }
  });
}
