// The screen reports dialog edges only, so a window that attaches while a dialog is up (a relaunch, a reload) is
// told what the screen shows at the re-mount.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isolateHome } from "./helpers/isolate-home.mjs";

// A claude pane's host looks up its config dir: HOME too, not only AYA_HOME, points at the temp dir.
const root = mkdtempSync(join(tmpdir(), "aya-vt-remount-"));
isolateHome(root);
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AYA_HOME, { recursive: true });

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor, fakeWebContents, ptyEventsFor } = await import("./helpers/pty-host.mjs");
const { HOLD_ACCOUNT_SETTING } = await import("../dist-electron/pane-holds.js");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const spawnReq = (ptyId, command, agent) => ({ ptyId, command, cwd: process.env.AYA_HOME, cols: 80, rows: 24, agent });
const DIALOG = `printf 'Do you want to proceed?\\n\\342\\235\\257 1. Yes\\n  2. No\\n'; exec cat`;
const PLAIN = `printf 'all done\\n'; exec cat`;
// Claude Code 2.1.289's account-wide offer, its rows as recorded (tests/fixtures/own-screens/claude-offer).
const OFFER_FILE = join(process.env.AYA_HOME, "offer.txt");
writeFileSync(OFFER_FILE, [
  " Allow this read outside the working directories?",
  " ❯ 1. Yes, and keep allowing any reads outside the working directories",
  "   2. No, and block reads outside the working directories from now on",
  "   3. No, and ask again next time",
  "",
].join("\n"));
const OFFER = `cat '${OFFER_FILE}'; exec cat`;

test("a window attaching to a pane: the dot says what the screen shows", async (t) => {
  const owner = new PtyHostClient(HOST_SCRIPT);
  const first = fakeWebContents();
  owner.attachWebContents(first);
  t.after(() => owner.shutdown().catch(() => {}));
  // [pane, command, agent, what the screen says: [waiting, the dialog's name]]
  const panes = [["dialog", DIALOG, undefined, [[true, undefined]]], ["offer", OFFER, "claude", [[true, HOLD_ACCOUNT_SETTING]]], ["plain", PLAIN, undefined, []]];
  for (const [id, command, agent] of panes) await owner.spawn(spawnReq(id, command, agent));
  await waitFor(() => ptyEventsFor(first, "dialog").some((e) => e.type === "vt-status" && e.waiting));
  await waitFor(() => ptyEventsFor(first, "offer").some((e) => e.type === "vt-status" && e.waiting));
  await waitFor(() => ptyEventsFor(first, "plain").some((e) => e.type === "data" && e.chunk.includes("all done")));
  const said = (wc, id) => ptyEventsFor(wc, id).filter((e) => e.type === "vt-status").map((e) => [e.waiting, e.dialog]);
  assert.deepEqual(said(first, "offer"), [[true, HOLD_ACCOUNT_SETTING]], "the live edge names the offer");

  const later = new PtyHostClient(HOST_SCRIPT);
  const second = fakeWebContents();
  later.attachWebContents(second);
  for (const [id, command, agent] of panes) await later.spawn(spawnReq(id, command, agent));
  for (const [id, , , says] of panes) {
    await waitFor(() => ptyEventsFor(second, id).some((e) => e.type === "data" && e.replay));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(said(second, id), says, id);
  }
  for (const [id] of panes) await later.kill(id);
});
