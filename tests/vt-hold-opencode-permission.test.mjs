// OpenCode 1.18.30's permission dialog, recorded at 80 and 134 columns, replaces the composer: no ╹ edge is left.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateScreen } from "../dist-electron/agent-screen-rules.js";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

// paneHold waits for xterm's write callback before reading; no parser sleep is needed.

const read = (name) => readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf8").replace(/\n+$/, "").split("\n");
const APPROVAL = "shows an approval prompt";

const DIALOG = { 80: read("opencode-permission-80.screen.txt"), 134: read("opencode-permission-134.screen.txt") };
// The composer back after the answer, as busy-opencode.screen.txt draws it (busy marker dropped).
const OC_BUSY = read("busy-opencode.screen.txt");
const answered = (width) => [
  ...DIALOG[width].slice(0, 10),
  "  ┃",
  "  ┃  Build · Big Pickle OpenCode Zen",
  OC_BUSY.find((row) => row.trimStart().startsWith("╹")).slice(0, width),
  "   ctrl+p commands    • OpenCode 1.18.30",
];

async function holds(width, ...screens) {
  openVtPane("p", width, DIALOG[width].length + 2, () => {}, "opencode", false);
  try {
    const out = [];
    for (const rows of screens) {
      writeVtPane("p", "\x1b[2J\x1b[H" + rows.join("\r\n"));
      out.push(await paneHold("p"));
    }
    return out;
  } finally {
    closeVtPane("p");
  }
}

for (const width of [80, 134]) {
  test(`opencode ${width} cols: the recorded permission dialog is a prompt`, async () => {
    assert.equal(evaluateScreen(DIALOG[width], "opencode"), "waiting");
    assert.deepEqual(await holds(width, DIALOG[width]), [APPROVAL]);
  });

  test(`opencode ${width} cols: dialog, then answered: held, then free`, async () => {
    assert.deepEqual(await holds(width, DIALOG[width], answered(width)), [APPROVAL, null]);
  });

  test(`opencode ${width} cols: free, then the dialog: free, then held`, async () => {
    assert.deepEqual(await holds(width, answered(width), DIALOG[width]), [null, APPROVAL]);
  });
}
