// Serialization must preserve the same busy/hold decisions, including dim placeholders and inverse cursor cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openVtPane, writeVtPane, paneHold, paneBusy, closeVtPane } from "../dist-electron/vt-state.js";
import { vtSnapshot } from "../dist-electron/vt-mirror.js";
import { snapshotHold, snapshotBusy } from "../dist-electron/vt-state.js";
const rule = "─".repeat(30);
for (const [name, screen, pasted] of [
  ["approval", "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No", undefined],
  ["busy", `${rule}\r\n❯ \r\n${rule}\r\nWorking (esc to interrupt)`, undefined],
  ["dim cursor placeholder", `${rule}\r\n❯ \x1b[7mT\x1b[0m\x1b[2mype a message\x1b[0m\r\n${rule}`, undefined],
  ["draft", `${rule}\r\n❯ my draft\r\n${rule}`, undefined],
  ["pasted question", `${rule}\r\n❯ Do you want to proceed?\r\n${rule}`, "Do you want to proceed?"],
  ["wide glyph", `${rule}\r\n❯ 漢字\r\n${rule}`, undefined],
]) {
  test(`snapshot preserves ${name}`, async () => {
    openVtPane(name, 80, 24, () => {}, "claude");
    try {
      writeVtPane(name, screen);
      const snapshot = JSON.parse(JSON.stringify(await vtSnapshot(name)));
      assert.equal(snapshotBusy(snapshot), await paneBusy(name));
      const expected = await paneHold(name, pasted);
      assert.equal(snapshotHold(snapshot, pasted).hold, expected);
    } finally { closeVtPane(name); }
  });
}
