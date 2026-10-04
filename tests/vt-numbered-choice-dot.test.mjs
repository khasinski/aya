// A numbered choice Claude asks is reported as waiting on both edges, as an approval dialog is.

import { test } from "node:test";
import assert from "node:assert/strict";

const { closeVtPane, openVtPane, writeVtPane, __testScanVtPane } = await import("../dist-electron/vt-state.js");

const settle = () => new Promise((r) => setTimeout(r, 30));
const RULE = "─".repeat(40);
const CHOICE = (selected) =>
  [
    "Which approach should I take?",
    "",
    ...[1, 2, 3].map((n) => `${n === selected ? "❯" : " "} ${n}. Option ${"ABC"[n - 1]}`),
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\r\n");
const IDLE = `${RULE}\r\n❯ \r\n${RULE}\r\n  ? for shortcuts\r\n`;
const CLEAR = "\x1b[2J\x1b[H";

// [label, agent, first screen, then, reports over scan, scan(after then)]
const ROWS = [
  ["selection on 2", "claude", CHOICE(2), null, [true]],
  ["selection on 1", "claude", CHOICE(1), null, [true]],
  ["selection on 3", "claude", CHOICE(3), null, [true]],
  ["answered: the idle composer is back", "claude", CHOICE(2), IDLE, [true, false]],
  ["a codex pane", "codex", CHOICE(2).replace(/❯/g, "›"), null, [true]],
  ["no agent rules (generic)", undefined, CHOICE(2), null, [true]],
  ["an idle composer only", "claude", IDLE, null, []],
  ["a draft the user typed", "claude", `${RULE}\r\n❯ fix the 2. thing\r\n${RULE}\r\n`, null, []],
];
for (const [label, agent, first, then, reports] of ROWS) {
  test(`numbered choice | ${label}`, async () => {
    const seen = [];
    openVtPane("c1", 80, 24, (waiting) => seen.push(waiting), agent);
    try {
      writeVtPane("c1", first);
      await settle();
      __testScanVtPane("c1");
      __testScanVtPane("c1");
      if (then) {
        writeVtPane("c1", CLEAR + then);
        await settle();
        __testScanVtPane("c1");
      }
      assert.deepEqual(seen, reports);
    } finally {
      closeVtPane("c1");
    }
  });
}
