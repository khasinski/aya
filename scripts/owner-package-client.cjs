// Runs only by the staged Electron-as-Node, never the product's main entrypoint.
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const assert = require("node:assert/strict");
const [resources, home] = process.argv.slice(2);
const { PtyOwnerClient, ownerArtifactPaths } = require(path.join(resources, "app.asar/dist-electron/pty-owner-client.js"));
(async () => {
  const artifacts = ownerArtifactPaths(path.join(resources, "app.asar/dist-electron"));
  const token = randomBytes(32), socket = path.relative(process.cwd(), path.join(home, "o"));
  const owner = spawn(artifacts.executable, ["--socket", socket, "--token-fd", "3"], { env: process.env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  owner.stdio[3].on("error", () => {}); owner.stdio[3].end(token);
  const closed = new Promise(resolve => owner.once("close", (code, signal) => resolve({ code, signal })));
  let client;
  async function readMarker(fd, needle) {
    let output = ""; const deadline = Date.now() + 5000, buffer = Buffer.alloc(4096);
    while (!output.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`Packaged PTY timed out: ${output}`);
      if (client.readReady(fd)) output += buffer.toString("utf8", 0, fs.readSync(fd, buffer));
      else await new Promise(resolve => setTimeout(resolve, 2));
    }
  }
  try {
    await Promise.race([new Promise(resolve => owner.stdout.once("data", resolve)), closed.then(result => { throw new Error(`Packaged owner did not start: ${JSON.stringify(result)}`); })]);
    client = await PtyOwnerClient.connect(socket, token, artifacts.bridge);
    const pane = await client.spawn({ id: "package", command: "/bin/sh", argv: ["sh", "-c", "read line; printf 'PACKAGE:%s\\n' \"$$\"; exit 23"],
      cwd: home, cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin", HOME: home } });
    fs.writeSync(pane.fd, "go\n");
    await readMarker(pane.fd, `PACKAGE:${pane.pid}`);
    const exit = await client.nextExit(); assert.equal(exit.exitCode, 23); await client.ackExit(exit); client.release(pane.fd);
    const js = await client.spawn({ id: "package-jit", command: process.execPath,
      argv: [process.execPath, "-e", "let sum=0; for(let i=0;i<100000;i++) sum+=i; console.log('JIT:'+sum); process.exit(24)"],
      cwd: home, cols: 80, rows: 24, env: { HOME: home, PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" } });
    await readMarker(js.fd, "JIT:4999950000"); const jsExit = await client.nextExit(); assert.equal(jsExit.exitCode, 24);
    await client.ackExit(jsExit); await client.shutdown();
    assert.equal((await closed).code, 0);
    console.log(JSON.stringify({ packageSmoke: "passed", platform: process.platform, arch: process.arch,
      electron: process.versions.electron, node: process.versions.node, ownerBuildId: client.buildId, exitCode: exit.exitCode, jsChildExitCode: jsExit.exitCode }));
  } finally {
    client?.close();
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
    const timer = setTimeout(() => owner.kill("SIGKILL"), 1500); await closed; clearTimeout(timer);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
