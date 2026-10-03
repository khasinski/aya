// The host reads the pane's screen for the hold check; the text Aya just pasted must reach
// it, or a message that quotes approval wording is never submitted (real host, fake claude).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-hq-")));
const bin = join(root, "bin");
const home = join(root, "home");
for (const dir of [bin, home]) mkdirSync(dir);
const rule = "-".repeat(40);
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh
stty -echo
composer() { printf '\\033[2J\\033[H%s\\n❯ %s\\n%s\\n  accept edits on\\n' '${rule}' "$1" '${rule}'; }
composer ""
read -r line
composer "$line"
exec sleep 30
`,
);
chmodSync(join(bin, "claude"), 0o755);
process.env.AYA_HOME = root;
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(root, "xdg-data");
process.env.SHELL = "/bin/sh";
process.env.PATH = `${bin}:/usr/bin:/bin`;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { HOST_EVENT_TIMEOUT_MS, fakeWebContents } = await import("./helpers/pty-host.mjs");

async function until(check) {
  const deadline = Date.now() + HOST_EVENT_TIMEOUT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the host ignores the pasted text when it reads the composer for the hold check", async (t) => {
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.attachWebContents(fakeWebContents());
  t.after(async () => {
    try {
      await client.kill("c");
      await client.shutdown();
    } catch {
      /* host already gone */
    }
  });
  await client.spawn({ ptyId: "c", command: join(bin, "claude"), cwd: root, cols: 80, rows: 24 });
  await until(async () => (await client.getBuffer("c")).includes("accept edits on"));
  const text = "Do you want me to run the tests?";
  await client.write("c", `${text}\r`);
  await until(async () => (await client.getBuffer("c")).includes(text));
  assert.equal(await client.holdReason("c"), "shows an approval prompt", "unmasked, the quote reads as a prompt");
  assert.equal(await client.holdReason("c", text), null, "the composer holds only Aya's own line: no prompt, no draft");
});
