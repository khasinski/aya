// The process table is read from `ps`; a busy machine lists more than execFile's
// default 1 MB of output, and the caller proof must not fail open because of that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin = mkdtempSync(join(tmpdir(), "aya-ps-"));
writeFileSync(join(bin, "ps"), `#!/bin/sh\nawk 'BEGIN { for (i = 1; i <= 20000; i++) print i, i - 1, "/usr/bin/tool --arg " sprintf("%0100d", i) }'\n`);
chmodSync(join(bin, "ps"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { readProcessTable } = await import("../dist-electron/caller-proof.js");

test("a process table larger than 1 MB is read whole", async () => {
  const table = await readProcessTable();
  assert.equal(table?.size, 20000);
});
