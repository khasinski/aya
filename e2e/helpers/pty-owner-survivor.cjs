const fs = require("node:fs");
if (process.env.AYA_TEST_SURVIVOR_PID_FILE) {
  fs.writeFileSync(process.env.AYA_TEST_SURVIVOR_PID_FILE, String(process.pid), { mode: 0o600 });
}
process.on("SIGHUP", () => {});
console.log(`SURVIVOR_READY:${process.pid}`);
setInterval(() => {}, 1000);
