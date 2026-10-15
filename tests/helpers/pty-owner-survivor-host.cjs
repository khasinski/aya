const { OwnerPty } = require("../../dist-electron/pty-owner-adapter.js");
const { getOwnerRuntime } = require("../../dist-electron/pty-owner-runtime.js");
(async () => {
  const pane = await OwnerPty.spawn({ id: "survivor", command: process.execPath,
    argv: [process.execPath, "-e", "process.on('SIGHUP',()=>{}); console.log('SURVIVOR_READY'); setInterval(()=>{},1000)"],
    cwd: process.env.AYA_HOME, cols: 80, rows: 24, env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" } });
  let output = "", announced = false;
  pane.onData(chunk => {
    output += chunk;
    if (!announced && output.includes("SURVIVOR_READY")) { announced = true; void getOwnerRuntime().then(owner => console.log(JSON.stringify(owner.record))); }
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
