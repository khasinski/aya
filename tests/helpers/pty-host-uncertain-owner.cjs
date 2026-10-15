const fs = require("node:fs"), path = require("node:path");
const { getOwnerRuntime } = require("../../dist-electron/pty-owner-runtime.js");
const { OwnerPty } = require("../../dist-electron/pty-owner-adapter.js");
(async () => {
  const owner = await getOwnerRuntime(), spawn = owner.client.spawn.bind(owner.client);
  owner.client.spawn = async spec => {
    const pane = await spawn(spec);
    fs.writeFileSync(path.join(process.env.AYA_HOME, "uncertain-child.json"), JSON.stringify({ child: pane.pid, owner: owner.record.pid }));
    owner.client.close(); throw new Error("Lost native SPAWN acknowledgement");
  };
  await OwnerPty.spawn({ id: "uncertain", command: "/bin/sh", argv: ["sh", "-c", "read line"], cwd: process.env.AYA_HOME,
    cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin", HOME: process.env.AYA_HOME } }).catch(() => {});
  require("../../dist-electron/pty-host.js");
})().catch(error => { console.error(error); process.exitCode = 1; });
