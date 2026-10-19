import test from "node:test";
import assert from "node:assert/strict";
import { PtyOwnerClient } from "../dist-electron/pty-owner-client.js";

test("a malformed error frame rejects its pending request instead of leaving spawn/list waiting forever", async () => {
  let deliver, timer;
  const native = {
    receive: () => new Promise(resolve => { deliver = resolve; }),
    send(_fd, request) {
      const frame = Buffer.alloc(18);
      frame.writeUInt32BE(0x41594150); frame.writeUInt16BE(2, 4); frame.writeUInt16BE(0x8001, 6);
      frame.writeUInt32BE(request.readUInt32BE(8), 8); frame.writeUInt32BE(2, 12);
      // A valid envelope with an incomplete error-string length.
      deliver({ data: frame, fd: -1 });
    },
    close() {},
  };
  const client = new PtyOwnerClient(native, 123);
  void client.pump();
  try {
    await assert.rejects(Promise.race([
      client.list(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Request stayed pending after malformed error")), 200); }),
    ]), /Owner connection closed/);
  } finally { clearTimeout(timer); client.close(); }
});
