// Exercises B2's actual packaged host/adapter under staged Electron-as-Node.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const [resources, home] = process.argv.slice(2);
const root = path.join(resources, "app.asar/dist-electron");
const { PtyHostClient } = require(path.join(root, "pty-host-client.js"));
const client = new PtyHostClient(path.join(root, "pty-host.js"));
let output = "", exited;
client.attachWebContents({ isDestroyed: () => false, send(_channel, event) {
  if (event.type === "data") output += event.chunk;
  if (event.type === "exit") exited = event.exitCode;
} });
async function until(predicate, message) {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${message}: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
(async () => {
  try {
    await client.spawn({ ptyId: "package-adapter", agent: "custom", cwd: home, cols: 80, rows: 24,
      command: "printf 'ADAPTER_READY:%s\\n' \"$$\"; read line; printf 'ADAPTER_REPLY:%s\\n' \"$line\"; exit 23" });
    await until(() => output.includes("ADAPTER_READY:"), "Packaged adapter did not become ready");
    const status = await client.hostStatus();
    const record = JSON.parse(fs.readFileSync(path.join(home, "pty-owner/record.json")));
    const pane = record.panes.find(pane => pane.id === "package-adapter");
    assert.equal(status.owner.pid, record.pid);
    const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pane.pid)], { encoding: "utf8" }).trim());
    assert.equal(parent, record.pid, "Packaged pane must have the native owner as parent");
    await client.resize("package-adapter", 101, 39);
    assert.equal(await client.write("package-adapter", "through-owner\n"), true);
    await until(() => exited !== undefined, "Packaged adapter did not receive the real exit");
    assert.equal(exited, 23); assert.match(output, /ADAPTER_REPLY:through-owner/);
    console.log(JSON.stringify({ packagedRuntime: "passed", platform: process.platform, arch: process.arch,
      electron: process.versions.electron, node: process.versions.node, nativeParent: parent, exitCode: exited }));
  } finally { await client.shutdown(); client.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
