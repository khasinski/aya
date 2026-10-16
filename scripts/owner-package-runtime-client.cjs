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
    const bundledRules = require(path.join(root, "screen-rule-data.js")).loadBundledScreenRules();
    const ruleEvidence = require(path.join(root, "agent-screen-rules.js")).evaluateScreenEvidence(["Do you want to proceed?"], "claude");
    assert.equal(Object.keys(bundledRules.sets).length, 6);
    assert.equal(ruleEvidence.verdict, "waiting"); assert.equal(ruleEvidence.match.id, "do-you-want");
    assert.equal(ruleEvidence.match.source, "builtin/generic");
    console.log(JSON.stringify({packagedScreenRules: "passed", version: bundledRules.version, digest: bundledRules.digest}));
    // Exercise the packaged shared row codec and compressed display receiver,
    // rather than relying only on file globs or source-side module availability.
    const rows = require(path.join(resources, "app.asar/shared/renderer-cell-runs.cjs"));
    const binding = require(path.join(root, "vt-checkpoint-binding.js"));
    const display = require(path.join(root, "renderer-vt-checkpoint.js"));
    const payload = require(path.join(root, "pty-checkpoint-payload.js"));
    const term = binding.createOwnedTerminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});
    try {
      await new Promise(resolve => term.write("\x1b[38;2;12;34;56mPACKAGED_ROW", resolve));
      const state = JSON.parse(binding.capture(term));
      for (const buffer of [state.normal,state.alternate]) for (const line of buffer.lines) {
        const bytes=Buffer.from(line.data,"base64"),words=new Uint32Array(line.length*3);
        for(let n=0;n<words.length;n++)words[n]=bytes.readUInt32LE(n*4);
        line.runs=rows.encodeCellRuns(words,line.length);delete line.data;
      }
      const raw=Buffer.from(JSON.stringify({format:2,browserEngine:display.BROWSER_ENGINE,state,cutLines:0,viewportClamped:false}));
      const packed=payload.encodeCheckpointPayload(raw);
      assert.equal(display.parseRendererCheckpoint(payload.decodeCheckpointPayload(packed)).cutLines,0);
      console.log(JSON.stringify({packagedDisplayCodec:"passed",rawBytes:raw.length,compressedBytes:packed.length}));
    } finally {term.dispose();}
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
