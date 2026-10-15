const fs = require("node:fs");
const path = require("node:path");
const { PtyOwnerClient } = require("../../dist-electron/pty-owner-client.js");
const [mode, home, bridge] = process.argv.slice(2);
(async () => {
  const client = await PtyOwnerClient.connect(path.relative(process.cwd(), path.join(home, "o")), fs.readFileSync(path.join(home, "token")), bridge);
  if (mode === "gap-exit") {
    const pane = await client.spawn({ id: "gap", cols: 80, rows: 24, cwd: home, command: "/bin/sh",
      argv: ["sh", "-c", "sleep 0.15; exit 23"], env: { PATH: "/usr/bin:/bin", HOME: home } });
    process.send({ pane });
    process.exit(0); // OS closes the control and master duplicates; owner stays.
  } else if (mode === "ack-gap") {
    const panes = await client.list(), events = client.takeExits();
    if (events.length !== 1 || events[0].exitCode !== 23) throw new Error(`Expected gap exit: ${JSON.stringify({ panes, events })}`);
    await client.ackExit(events[0]);
    await client.list();
    if (client.takeExits().length) throw new Error("Acknowledged exit was delivered again");
    process.send({ events, panes }); process.exit(0);
  } else if (mode === "post-ack") {
    const panes = await client.list(), events = client.takeExits();
    if (events.length || !panes[0]?.acknowledged) throw new Error("Acknowledged exit replayed on reconnect");
    process.send({ panes, events }); process.exit(0);
  } else if (mode === "crash-queued") {
    const { shellSpec, readUntil, sleep } = await import("./pty-owner.mjs");
    const pane = await client.spawn(shellSpec(home));
    await readUntil(client, pane.fd, `START:${pane.pid}`);
    if (client.readReady(pane.fd)) throw new Error("Expected an empty queue before known reply");
    fs.writeSync(pane.fd, "pending-before-crash\n");
    const deadline = Date.now() + 5000;
    while (!client.readReady(pane.fd)) {
      if (Date.now() > deadline) throw new Error("Unread reply did not become ready");
      await sleep(1);
    }
    if (client.readReady(pane.fd) !== 1) throw new Error("Expected POLLIN only");
    process.send({ pane, readReady: 1 });
    setTimeout(() => { throw new Error("Supervisor did not SIGKILL the client"); }, 6000);
  }
})().catch((error) => { console.error(error); process.exit(1); });
