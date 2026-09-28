// A real PTY and its vt mirror must agree on size, even below the PTY's floor,
// or screen rules read a screen the agent never drew. Temp HOME/AYA_HOME and
// /bin/sh keep the user's rc files and ~/.aya out of the run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "aya-geom-home-"));
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-geom-"));
process.env.SHELL = "/bin/sh";

const { killPty, resizePty, spawnPty, writePty } = await import("../dist-electron/pty.js");
const { __testVtPane } = await import("../dist-electron/vt-state.js");

async function waitFor(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

test("spawn and resize below the floor give the PTY and the mirror one size", async () => {
  const ptyId = "geom-" + Math.random().toString(36).slice(2);
  let out = "";
  const sink = {
    sendPtyEvent: (e) => {
      if (e.type === "data") out += e.chunk;
    },
    isDestroyed: () => false,
  };
  const sizes = () => [...out.matchAll(/(\d+) (\d+)\r\n/g)].map((m) => [+m[2], +m[1]]);
  const mirror = () => {
    const t = __testVtPane(ptyId).terminal;
    return [t.cols, t.rows];
  };
  try {
    await spawnPty({ ptyId, command: "sh -c 'stty size; read _; stty size; read _; stty size; read _'", cwd: "/tmp", cols: 2, rows: 1 }, sink);
    await waitFor(() => sizes().length === 1);
    assert.deepEqual(mirror(), sizes()[0]);

    resizePty(ptyId, 12, 6);
    await writePty(ptyId, "\r");
    await waitFor(() => sizes().length === 2);
    assert.deepEqual(mirror(), sizes()[1]);

    resizePty(ptyId, 3, 1);
    await writePty(ptyId, "\r");
    await waitFor(() => sizes().length === 3);
    assert.deepEqual(mirror(), sizes()[2]);
    assert.deepEqual(sizes(), [[4, 2], [12, 6], [4, 2]]);
  } finally {
    killPty(ptyId);
  }
});
