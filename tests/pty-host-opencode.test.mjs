// The pty host, not main, swaps opencode's `--continue` for the pane's own
// session: only there is a real spawn certain. The fake opencode is reachable
// only through the PATH the pane's login shell builds (~/.profile), as for a
// user whose opencode lives on a PATH set up by shell startup files. HOME,
// XDG_DATA_HOME, SHELL and PATH are all fake, so no real opencode is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-ptyhost-oc-")));
const bin = join(root, "bin");
const cwd = join(root, "wt-a");
mkdirSync(bin);
mkdirSync(cwd);
writeFileSync(
  join(bin, "opencode"),
  [
    "#!/bin/sh",
    'if [ "$1" = session ]; then',
    `  printf '[{"id":"ses_sibling","directory":"/elsewhere","updated":9},{"id":"ses_own","directory":"%s","updated":1}]' "$(pwd -P)"`,
    "  exit 0",
    "fi",
    'echo "OPENCODE-ARGS:$*"',
    "",
  ].join("\n"),
);
chmodSync(join(bin, "opencode"), 0o755);
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "xdg-data");
process.env.PATH = "/usr/bin:/bin";
process.env.SHELL = "/bin/sh";
mkdirSync(process.env.HOME);
writeFileSync(join(process.env.HOME, ".profile"), `PATH='${bin}':$PATH\nexport PATH\n`);

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");

test("a spawned opencode --continue pane is launched with its own directory's session", async (t) => {
  const events = [];
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.attachWebContents({
    isDestroyed: () => false,
    send: (channel, payload) => channel === "pty:event" && events.push(payload),
  });
  t.after(() => client.shutdown().catch(() => {}));

  await client.spawn({ ptyId: "oc-1", command: "opencode --continue", cwd, cols: 80, rows: 24 });
  const deadline = Date.now() + 15_000;
  while (!events.some((e) => e.type === "exit") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const output = events.filter((e) => e.type === "data").map((e) => e.chunk).join("");
  assert.match(output, /OPENCODE-ARGS:--session ses_own\s/);
});
