const fs = require("node:fs");
const path = require("node:path");
const markerArg = process.argv.find((arg) => arg.startsWith("--aya-e2e-survivor="));
if (!markerArg) throw new Error("A unique e2e survivor marker is required");
if (process.env.AYA_TEST_SURVIVOR_PID_FILE) {
  const { ownerProcessStartIdentity } = require(path.join(process.env.AYA_TEST_APP_ROOT, "dist-electron/pty-owner-client.js"));
  const startIdentity = ownerProcessStartIdentity(process.pid);
  if (!startIdentity) throw new Error("Cannot identify the e2e survivor process");
  fs.writeFileSync(process.env.AYA_TEST_SURVIVOR_PID_FILE, JSON.stringify({ pid: process.pid, startIdentity, marker: markerArg }), { mode: 0o600 });
}
process.on("SIGHUP", () => {});
console.log(`SURVIVOR_READY:${process.pid}`);
setInterval(() => {}, 1000);
