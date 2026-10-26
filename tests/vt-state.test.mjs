// Server-side screen mirror. The whole point of this module is that it knows
// what a pane SHOWS, not merely what bytes went past — so the tests that
// matter are the ones a raw-byte regex would get wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __testScanVtPane,
  __testVtPane,
  closeAllVtPanes,
  closeVtPane,
  openVtPane,
  resizeVtPane,
  screenShowsApproval,
  vtPaneAltScreen,
  writeVtPane,
} from "../dist-electron/vt-state.js";
import { snapshotOf, vtSnapshot } from "../dist-electron/vt-mirror.js";
import { asVtSnapshot, vtSnapshotValidationError } from "../dist-electron/pty-host-protocol.js";
import { MIN_PTY_COLS, MIN_PTY_ROWS } from "../dist-electron/constants.js";
import { HOLD_APPROVAL, HOLD_SCREEN_CLIPPED } from "../dist-electron/pane-holds.js";
import { snapshotHold } from "../dist-electron/vt-state.js";

// xterm parses writes asynchronously, so a scan must come after a tick.
const settle = () => new Promise((r) => setTimeout(r, 20));

function open(id, onChange = () => {}) {
  openVtPane(id, 80, 24, onChange);
  return () => closeVtPane(id);
}

test("an approval prompt on screen is detected", async () => {
  const close = open("p1");
  writeVtPane("p1", "Do you want to proceed?\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p1").terminal), true);
  close();
});

test("a prompt that was REPAINTED AWAY is not detected", async () => {
  // The regression this module exists for: the bytes still contain the
  // prompt, but the agent has cleared the screen since. A byte-stream matcher
  // would keep the terminal stuck as "waiting" forever.
  const close = open("p2");
  writeVtPane("p2", "Do you want to proceed?\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p2").terminal), true);

  writeVtPane("p2", "\x1b[H\x1b[2JAll done, nothing pending.\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p2").terminal), false);
  close();
});

test("a prompt scrolled off the visible screen is not detected", async () => {
  const close = open("p3");
  writeVtPane("p3", "Do you want to proceed?\r\n");
  writeVtPane("p3", "filler\r\n".repeat(60));
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p3").terminal), false);
  close();
});

test("ordinary output is not mistaken for a prompt", async () => {
  const close = open("p4");
  writeVtPane("p4", "Compiling module foo\r\nDone in 2.1s\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p4").terminal), false);
  close();
});

test("a bare [y/n] at the end of a line counts as a prompt", async () => {
  const close = open("p5");
  writeVtPane("p5", "Overwrite existing file? [y/n]");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p5").terminal), true);
  close();
});

// --- change notification ---------------------------------------------------

test("the change callback fires on BOTH edges, once per transition", async () => {
  const seen = [];
  const close = open("p8", (waiting) => seen.push(waiting));

  writeVtPane("p8", "Do you want to proceed?\r\n");
  await settle();
  __testScanVtPane("p8");
  assert.deepEqual(seen, [true]);

  // A second scan with the screen unchanged must not re-fire.
  __testScanVtPane("p8");
  assert.deepEqual(seen, [true]);

  writeVtPane("p8", "\x1b[H\x1b[2Jmoving on\r\n");
  await settle();
  __testScanVtPane("p8");
  assert.deepEqual(seen, [true, false]);
  close();
});

// --- lifecycle -------------------------------------------------------------

test("writing to an unknown pane is a silent no-op, not a throw", () => {
  assert.doesNotThrow(() => writeVtPane("ghost", "hi"));
  assert.doesNotThrow(() => resizeVtPane("ghost", 10, 10));
  assert.doesNotThrow(() => closeVtPane("ghost"));
});

test("closing a pane drops it, so a respawned id starts clean", async () => {
  const close = open("p9");
  writeVtPane("p9", "Do you want to proceed?\r\n");
  await settle();
  close();
  assert.equal(__testVtPane("p9"), undefined);

  open("p9")();
  assert.equal(__testVtPane("p9"), undefined);
});

test("resize keeps the pane usable", async () => {
  const close = open("p10");
  resizeVtPane("p10", 40, 10);
  writeVtPane("p10", "Do you want to proceed?\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p10").terminal), true);
  close();
});

test("the B4 cols-minus-one/back redraw nudge keeps applied mirror snapshots valid", async () => {
  const id = "resize-nudge-snapshot";
  openVtPane(id, 120, 40, () => {}, "codex");
  try {
    for (let i = 0; i < 80; i++) {
      writeVtPane(id, `\x1b[${i % 38 + 1};${i % 118 + 1}H${"x".repeat(i % 117 + 1)}`);
      resizeVtPane(id, 119, 40);
      resizeVtPane(id, 120, 40);
      const snapshot = await vtSnapshot(id);
      assert.ok(snapshot, "a live pane should produce a snapshot");
      assert.ok(asVtSnapshot(snapshot), "resized rows and cells must match the reported viewport");
      assert.equal(snapshot.cols, 120);
      assert.equal(snapshot.cells.length, snapshot.rows.length);
    }
  } finally { closeVtPane(id); }
});

test("snapshots stay within visible columns after resize across screen content shapes", async (t) => {
  const sequences = [
    { name: "wide-to-narrow", initialCols: 120, resize: [[40, 24]] },
    { name: "narrow-to-wide", initialCols: 40, resize: [[120, 24]] },
    { name: "narrow with wrapped long line", initialCols: 120, longLine: true, resize: [[40, 24]] },
    { name: "alternate screen", initialCols: 120, enterAlt: true, resize: [[40, 24]] },
  ];
  const contents = [
    {
      name: "plain text at the edge",
      writeAtEdge: (cols) => `\x1b[1;${cols}H P`,
    },
    {
      name: "wide character at the edge",
      writeAtEdge: (cols) => `\x1b[1;${Math.max(1, cols - 1)}H漢`,
    },
    {
      name: "dim and inverse cells at the edge",
      writeAtEdge: (cols) => `\x1b[1;${Math.max(1, cols - 1)}H\x1b[2mD\x1b[0m\x1b[1;${cols}H\x1b[7mI\x1b[0m`,
    },
  ];
  let paneIndex = 0;
  for (const sequence of sequences) {
    for (const content of contents) {
      await t.test(`${sequence.name} / ${content.name}`, async () => {
        const id = `snapshot-cols-${paneIndex++}`;
        openVtPane(id, sequence.initialCols, 24, () => {}, "claude");
        try {
          if (sequence.enterAlt) writeVtPane(id, "\x1b[?1049h");
          if (sequence.longLine) writeVtPane(id, "L".repeat(240));
          writeVtPane(id, content.writeAtEdge(sequence.initialCols));
          await settle();
          for (const [cols, rows] of sequence.resize) resizeVtPane(id, cols, rows);
          await settle();
          writeVtPane(id, content.writeAtEdge(__testVtPane(id).terminal.cols));
          await settle();

          const pane = __testVtPane(id);
          const snapshot = snapshotOf(pane);
          assert.ok(asVtSnapshot(snapshot), "producer output satisfies the strict snapshot validator");
          assert.ok(snapshot.cells.flat().every(([column]) => column >= 0 && column < snapshot.cols));
          assert.deepEqual(
            snapshot.rows,
            Array.from({ length: pane.terminal.buffer.active.length }, (_, y) =>
              pane.terminal.buffer.active.getLine(y)?.translateToString(true, 0, pane.terminal.cols) ?? "",
            ),
            "row text contains only the visible screen columns",
          );
        } finally {
          closeVtPane(id);
        }
      });
    }
  }
});

test("snapshot validation still rejects a cell beyond the reported columns", async () => {
  const id = "snapshot-cols-validator-remains-strict";
  openVtPane(id, 40, 24, () => {}, "claude");
  try {
    const snapshot = snapshotOf(__testVtPane(id));
    const cells = snapshot.cells.map((row) => [...row]);
    cells[0].push([snapshot.cols, "x", 0, 0]);
    assert.equal(asVtSnapshot({ ...snapshot, cells }), null);
    assert.ok(asVtSnapshot({ ...snapshot, clippedVisible: true }));
    assert.equal(asVtSnapshot({ ...snapshot, clippedVisible: "yes" }), null);
  } finally {
    closeVtPane(id);
  }
});

test("a narrowed visible approval prompt is held until widening restores its full text", async (t) => {
  for (const prompt of ["Do you want to proceed? [y/n]", "Allow this action?"]) {
    await t.test(prompt, async () => {
      const cols = { value: 120 };
      const text = `${" ".repeat(29)}${prompt}`;
      const chars = Array.from(text);
      const promptLine = {
        length: 120,
        translateToString: (_trim, start = 0, end = 120) => chars.slice(start, end).join("").trimEnd(),
        getCell: (x) => chars[x] === undefined ? undefined : {
          getChars: () => chars[x], isDim: () => 0, isInverse: () => 0,
        },
      };
      const blankLine = {
        length: 120,
        translateToString: () => "",
        getCell: () => undefined,
      };
      const lines = Array.from({ length: 24 }, (_, y) => y === 23 ? promptLine : blankLine);
      const pane = {
        terminal: {
          get cols() { return cols.value; },
          rows: 24,
          buffer: { active: { length: 24, viewportY: 0, getLine: (y) => lines[y] } },
        },
        agent: "claude",
        shell: false,
        composerSeen: true,
        openedAt: Date.now(),
        lastOutputAt: null,
      };
      assert.equal(snapshotHold(snapshotOf(pane)).hold, HOLD_APPROVAL);

      cols.value = 40; // Model xterm retaining the old row allocation after narrowing.
      const narrow = snapshotOf(pane);
      assert.equal(narrow.rows.join("\n").includes(prompt), false, "the dialog tail is outside the visible width");
      assert.equal(narrow.clippedVisible, true);
      assert.ok(asVtSnapshot(narrow), vtSnapshotValidationError(narrow));
      assert.equal(snapshotHold(narrow).hold, HOLD_SCREEN_CLIPPED);

      cols.value = 120;
      const wide = snapshotOf(pane);
      assert.equal(wide.clippedVisible, undefined, "widening removes the clipped-screen marker");
      assert.equal(snapshotHold(wide).hold, HOLD_APPROVAL, "the restored prompt is recognized normally");
    });
  }
});

test("wide content in scrollback does not mark the visible snapshot clipped", () => {
  const row = (text, length = 40, extra = []) => {
    const cells = new Map([...Array.from(text).map((char, x) => [x, [char, 0, 0]]), ...extra]);
    return {
      length,
      translateToString: (_trim, start = 0, end = length) =>
        Array.from({ length: end - start }, (_, i) => cells.get(start + i)?.[0] ?? " ").join("").trimEnd(),
      getCell: (x) => {
        const cell = cells.get(x);
        return cell ? { getChars: () => cell[0], isDim: () => cell[1], isInverse: () => cell[2] } : undefined;
      },
    };
  };
  const oldScrollback = row("old history", 80, [[60, ["old wide tail", 0, 0]]]);
  const visibleOutput = row("recent output");
  const visibleComposer = row("❯ ");
  const lines = [oldScrollback, visibleOutput, visibleComposer];
  const pane = {
    terminal: {
      cols: 40,
      rows: 2,
      buffer: { active: { length: lines.length, viewportY: 1, getLine: (y) => lines[y] } },
    },
    agent: "claude",
    shell: false,
    composerSeen: true,
    openedAt: Date.now(),
    lastOutputAt: null,
  };
  const snapshot = snapshotOf(pane);
  assert.equal(snapshot.clippedVisible, undefined);
  assert.equal(snapshotHold(snapshot).hold, null);
});

test("closeAllVtPanes clears everything (host shutdown)", async () => {
  open("p11");
  open("p12");
  closeAllVtPanes();
  assert.equal(__testVtPane("p11"), undefined);
  assert.equal(__testVtPane("p12"), undefined);
});

test("the mirror knows when a pane holds the alt screen", async () => {
  const close = open("alt");
  assert.equal(vtPaneAltScreen("alt"), false);
  writeVtPane("alt", "\x1b[?1049h");
  await settle();
  assert.equal(vtPaneAltScreen("alt"), true);
  writeVtPane("alt", "\x1b[?1049l");
  await settle();
  assert.equal(vtPaneAltScreen("alt"), false);
  close();
  assert.equal(vtPaneAltScreen("alt"), undefined);
});

test("the mirror floors its size where the PTY does, so both see one screen", () => {
  const size = (id) => {
    const t = __testVtPane(id).terminal;
    return [t.cols, t.rows];
  };
  openVtPane("p13", 2, 1, () => {});
  assert.deepEqual(size("p13"), [MIN_PTY_COLS, MIN_PTY_ROWS]);
  resizeVtPane("p13", 40, 10);
  assert.deepEqual(size("p13"), [40, 10]);
  resizeVtPane("p13", 3, 1);
  assert.deepEqual(size("p13"), [MIN_PTY_COLS, MIN_PTY_ROWS]);
  resizeVtPane("p13", MIN_PTY_COLS + 1, MIN_PTY_ROWS + 1);
  assert.deepEqual(size("p13"), [MIN_PTY_COLS + 1, MIN_PTY_ROWS + 1]);
  closeVtPane("p13");
  openVtPane("p14", 40, 10, () => {});
  assert.deepEqual(size("p14"), [40, 10]);
  closeVtPane("p14");
  assert.deepEqual([MIN_PTY_COLS, MIN_PTY_ROWS], [4, 2]);
});
