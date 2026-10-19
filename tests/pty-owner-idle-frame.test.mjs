import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ownerArtifactPaths } = require("../dist-electron/pty-owner-client.js");
test("a frame started during an idle receive gets its own bounded body budget", async (t) => {
  fs.mkdirSync("test-results", { recursive: true }); const dir = fs.mkdtempSync(path.resolve("test-results/frame-"));
  const socket = path.relative(process.cwd(), path.join(dir, "o")), server = net.createServer();
  let fd = -1, peer, timer;
  const native = require(ownerArtifactPaths(process.env.AYA_OWNER_ARTIFACT_DIR || path.resolve("dist-electron")).bridge);
  t.after(async () => {
    clearTimeout(timer); if (fd >= 0) native.close(fd, true); peer?.destroy();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const accepted = once(server, "connection"); fd = native.connect(socket); [peer] = await accepted;
  const body = Buffer.from("COMPLETE"), frame = Buffer.alloc(16 + body.length);
  frame.writeUInt32BE(0x41594150); frame.writeUInt16BE(2, 4); frame.writeUInt16BE(0x8000, 6); frame.writeUInt32BE(1, 8); frame.writeUInt32BE(body.length, 12); body.copy(frame, 16);
  peer.write(frame.subarray(0, 1)); // already queued before receive's idle timer starts
  const received = native.receive(fd, 25);
  timer = setTimeout(() => peer.write(frame.subarray(1)), 75);
  const reply = await received; assert.deepEqual(reply.data, frame); assert.equal(reply.fd, -1);
});
