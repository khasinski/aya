// Deliberately pre-owner host protocol; a real child remains its responsibility.
const net = require("node:net"), fs = require("node:fs"), path = require("node:path");
const { spawn } = require("node:child_process");
const socket = path.join(process.env.AYA_HOME, "pty-host.sock");
// Released legacy hosts wrote their PID/start registry before authentication
// existed. Keep that private evidence, while refusing to invent pane inventory.
const registry=require('../../dist-electron/pty-host-registry.js');
const info=registry.readProcInfo(process.pid);
registry.writeHostRecord({pid:process.pid,pgid:registry.ownPgid(),version:'0.12.0',scriptHash:'0'.repeat(64),startTime:info.startTime,nonce:'legacy-fixture'});
const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
const unknownChild=spawn("/bin/sleep",["60"],{stdio:"ignore"});
const stopped = Promise.all([child,unknownChild].map(c=>new Promise(resolve=>c.once("exit",resolve))));
let ending = false;
async function shutdown() {
  if (ending) return; ending = true;
  child.kill("SIGKILL");unknownChild.kill("SIGKILL"); await stopped; server.close(); fs.rmSync(socket, { force: true }); process.exit(0);
}
const server = net.createServer(client => {
  let buffer = ""; client.setEncoding("utf8");
  client.on("error", () => {});
  client.on("data", bytes => {
    buffer += bytes;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n"), request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      let result = null;
      if (request.type === "version") result = { version: "0.12.0", scriptHash: "0".repeat(64), pid: process.pid, ptyCount: 2 };
      if (request.type === "pid") result = request.ptyId === "tab-left" ? child.pid : null;
      if (request.type === "buffer") result = "legacy process remains alive";
      if (request.type === "size") result = request.ptyId === "tab-left" ? { cols: 80, rows: 24 } : null;
      if (request.type === "spawn") client.write(JSON.stringify({ type: "event", event: request.req.ptyId === "tab-left" ? { type: "data", ptyId: "tab-left", chunk: "legacy process remains alive\r\n" } : { type: "no-session", ptyId: request.req.ptyId } }) + "\n");
      client.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
      if (request.type === "shutdown") void shutdown();
    }
  });
});
server.listen(socket, () => { fs.chmodSync(socket, 0o600); process.stdout.write(JSON.stringify({ pid: process.pid, child: child.pid, unknownChild:unknownChild.pid }) + "\n"); });
process.once("SIGTERM", shutdown);
