const fs = require("node:fs"), path = require("node:path");
const { OwnerPty } = require("../../dist-electron/pty-owner-adapter.js");
const original = OwnerPty.spawn.bind(OwnerPty);
OwnerPty.spawn = async spec => {
  const pane = await original(spec);
  fs.writeFileSync(path.join(process.env.AYA_HOME, "lost-first-spawn.json"), JSON.stringify({ pid: pane.pid }));
  process.kill(process.pid, "SIGKILL");
  return pane;
};
require("../../dist-electron/pty-host.js");
