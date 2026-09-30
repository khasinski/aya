// The pty host starts interactive Codex with --no-daemon when the installed
// codex has it: its shared daemon ran every pane's commands with the env of the
// pane that started it. HOME, SHELL and PATH are fake; no real codex runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-ptyhost-codex-")));
const cwd = join(root, "project");
mkdirSync(cwd);

function fakeCodex(dir, helpOption) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "codex");
  writeFileSync(
    file,
    ["#!/bin/sh", `if [ "$1" = --help ]; then echo '      ${helpOption}'; exit 0; fi`, 'echo "CODEX-ARGS:$*"', ""].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

const bin = join(root, "bin");
fakeCodex(bin, "--no-daemon");
const oldCodex = fakeCodex(join(root, "old"), "--model <MODEL>");
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.PATH = "/usr/bin:/bin";
process.env.SHELL = "/bin/sh";
mkdirSync(process.env.HOME);
writeFileSync(join(process.env.HOME, ".profile"), `PATH='${bin}':$PATH\nexport PATH\n`);

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");

async function spawnOutput(t, ptyId, command) {
  const events = [];
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.attachWebContents({
    isDestroyed: () => false,
    send: (channel, payload) => channel === "pty:event" && events.push(payload),
  });
  t.after(() => client.shutdown().catch(() => {}));
  await client.spawn({ ptyId, command, cwd, cols: 80, rows: 24 });
  const deadline = Date.now() + 15_000;
  while (!events.some((e) => e.type === "exit") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return events.filter((e) => e.type === "data").map((e) => e.chunk).join("");
}

test("a codex resume pane is launched with --no-daemon after the binary", async (t) => {
  const output = await spawnOutput(t, "cx-1", `CODEX_HOME='${join(root, "codex-home")}' codex resume --last`);
  assert.match(output, /CODEX-ARGS:--no-daemon resume --last\s/);
});

test("a codex without --no-daemon in its help is launched as the preset says", async (t) => {
  const output = await spawnOutput(t, "cx-2", `${oldCodex} resume --last`);
  assert.match(output, /CODEX-ARGS:resume --last\s/);
});
