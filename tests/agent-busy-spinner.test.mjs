// Claude is busy while its spinner row is up: the footer's "esc to interrupt" is cut off in a narrow pane
// and at times replaced by a notice. "✻ Crunched for 15s" is a finished turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { screenIsBusy, TAIL_REGION_LINES } = await import("../dist-electron/agent-screen-rules.js");

const lines = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trimEnd().split("\n");
const BUSY = lines("busy-claude.screen.txt");
const RULE = "─".repeat(60);
const IDLE_TAIL = [RULE, "❯ ", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle) · PR #128"];
const without = (rows, drop) => rows.filter((r) => !drop.test(r));

// [label, rows, agent, busy]
const ROWS = [
  ["the captured busy screen", BUSY, "claude", true],
  ["the captured screen, footer cut off in a narrow pane", [...BUSY.slice(0, -1), "  ⏵⏵ auto mode on (shift+tab to cycle) · PR #128 · esc t"], "claude", true],
  ["the captured screen, footer replaced by a notice", [...BUSY.slice(0, -1), "  ⚠ Update available: run claude update"], "claude", true],
  ["the captured screen, no footer at all", BUSY.slice(0, -1), "claude", true],
  ["/compact: 'Compacting conversation…' and an idle-looking footer", ["✻ Compacting conversation… (12s)", ...IDLE_TAIL], "claude", true],
  ["a spinner with its timer and hint", ["✻ Burrowing… (3s · esc to interrupt)", ...IDLE_TAIL], "claude", true],
  ["every spinner glyph", ["✢", "✳", "✶", "✻", "✽"].map((g) => [`${g} Pondering…`, ...IDLE_TAIL]).flat(), "claude", true],
  ["an idle composer", ["  ? for shortcuts", ...IDLE_TAIL.slice(0, 3)], "claude", false],
  ["a finished turn: 'Crunched for 15s' above the composer", ["✻ Crunched for 15s · done 7:38 PM", "", ...IDLE_TAIL], "claude", false],
  ["a finished turn with an ellipsis in the prose", ["⏺ Done, see the log…", ...IDLE_TAIL], "claude", false],
  [`the spinner row scrolled up out of the last ${TAIL_REGION_LINES} rows`, ["✽ Generating…", ...Array.from({ length: TAIL_REGION_LINES }, (_, i) => `output ${i}`), ...IDLE_TAIL], "claude", false],
  ["the captured screen without its spinner row, footer still there", without(BUSY, /Generating/), "claude", true],
  ["the same spinner row on a Codex pane is not Claude's marker", ["✽ Generating…", ...IDLE_TAIL], "codex", false],
  ["the same spinner row on an OpenCode pane", ["✽ Generating…", ...IDLE_TAIL], "opencode", false],
  ["the same spinner row on an unknown agent", ["✽ Generating…", ...IDLE_TAIL], undefined, false],
];
for (const [label, rows, agent, busy] of ROWS) {
  test(`screenIsBusy | ${label}`, () => assert.equal(screenIsBusy(rows, agent), busy));
}
