const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { getOwnerRuntime, shutdownOwnerRuntime } = require("../../dist-electron/pty-owner-runtime.js");
const { OwnerPty } = require("../../dist-electron/pty-owner-adapter.js");
const { confirmRestart } = require("../../dist-electron/relaunch-notes.js");
(async () => {
  const owner = await getOwnerRuntime(), pane = owner.record.panes[0], mode = process.argv[2];
  assert.equal(owner.incompatible, true); assert.equal(owner.disconnected.get(pane.id).pid, pane.pid);
  await assert.rejects(OwnerPty.spawn({ id: pane.id }), /disconnected or incompatible/);
  const deps = { file: path.join(process.env.AYA_HOME, "relaunch-notes.json"), panes: async () => [{ id: pane.id, name: "Survivor" }],
    disconnected: async () => true, pid: async () => pane.pid };
  const agreed = await confirmRestart(deps, "Restarting the terminal host", async text => {
    assert.match(text, /Survivor: disconnected/); return mode !== "cancel";
  });
  if (!agreed) { console.log(JSON.stringify({ cancelled: true, kept: owner.record.panes })); return; }
  try { await owner.shutdown(); }
  catch (error) { console.log(JSON.stringify({ refused: error.message, kept: owner.record.panes })); return; }
  assert.equal(fs.existsSync(path.join(process.env.AYA_HOME, "pty-owner/record.json")), false);
  const replacement = await OwnerPty.spawn({ id: pane.id, command: "/bin/sh", argv: ["sh", "-c", "read line"], cwd: process.env.AYA_HOME,
    cols: 80, rows: 24, env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" } });
  assert.notEqual(replacement.pid, pane.pid); replacement.onData(() => {}); replacement.kill("SIGKILL"); await replacement.closed;
  await shutdownOwnerRuntime(); console.log(JSON.stringify({ stopped: pane.pid, replacement: replacement.pid }));
})().catch(error => { console.error(error); process.exitCode = 1; });
