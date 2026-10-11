// A socket Aya listens on is owner-only from the moment it exists, not only from the listening
// callback's chmod: with the default umask the file was 0755 in between.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenOwnerOnly } from "../dist-electron/owner-socket.js";

// process.umask() with no argument is deprecated: read it by setting it back.
const currentUmask = () => {
  const mask = process.umask(0o022);
  process.umask(mask);
  return mask;
};

test("the socket has no group or other bits as soon as listen returns, 0600 once listening, and the umask is back", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-owner-socket-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "aya.sock");
  const server = net.createServer();
  t.after(() => server.close());
  const umask = currentUmask();
  const listening = new Promise((resolve) => listenOwnerOnly(server, socketPath, resolve));
  assert.equal(statSync(socketPath).mode & 0o077, 0, "nobody but the owner, before any callback ran");
  assert.equal(currentUmask(), umask, "the process umask is restored right away");
  await listening;
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
});
