// The screen reports dialog edges only, so a window that attaches while a dialog is up (a relaunch, a reload) is
// told what the screen shows at the re-mount.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-vt-remount-"));

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor, fakeWebContents, ptyEventsFor } = await import("./helpers/pty-host.mjs");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const spawnReq = (ptyId, command) => ({ ptyId, command, cwd: process.env.AYA_HOME, cols: 80, rows: 24 });
const DIALOG = `printf 'Do you want to proceed?\\n\\342\\235\\257 1. Yes\\n  2. No\\n'; exec cat`;
const PLAIN = `printf 'all done\\n'; exec cat`;

test("a window attaching to a pane: the dot says what the screen shows", async (t) => {
  const owner = new PtyHostClient(HOST_SCRIPT);
  const first = fakeWebContents();
  owner.attachWebContents(first);
  t.after(() => owner.shutdown().catch(() => {}));
  // [pane, command, the screen waits]
  const panes = [["dialog", DIALOG, true], ["plain", PLAIN, false]];
  for (const [id, command] of panes) await owner.spawn(spawnReq(id, command));
  await waitFor(() => ptyEventsFor(first, "dialog").some((e) => e.type === "vt-status" && e.waiting));
  await waitFor(() => ptyEventsFor(first, "plain").some((e) => e.type === "data" && e.chunk.includes("all done")));

  const later = new PtyHostClient(HOST_SCRIPT);
  const second = fakeWebContents();
  later.attachWebContents(second);
  for (const [id, command] of panes) await later.spawn(spawnReq(id, command));
  for (const [id, , waits] of panes) {
    await waitFor(() => ptyEventsFor(second, id).some((e) => e.type === "data" && e.replay));
    await new Promise((r) => setTimeout(r, 300));
    const said = ptyEventsFor(second, id).filter((e) => e.type === "vt-status").map((e) => e.waiting);
    assert.deepEqual(said, waits ? [true] : [], id);
  }
  for (const [id] of panes) await later.kill(id);
});
