// Repeatable local-only measurement: 30 live PTYs and applied VT snapshots over the Unix socket.
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const root = mkdtempSync(join(tmpdir(), "aya-snapshot-measure-"));
process.env.AYA_HOME = root;
process.env.SHELL = "/bin/sh";
const { PtyHostClient, waitForExit } = require("../dist-electron/pty-host-client");
const { snapshotHold, snapshotBusy } = require("../dist-electron/vt-state");
const client = new PtyHostClient(join(__dirname, "../dist-electron/pty-host.js"));
const ids = Array.from({ length: 30 }, (_, i) => `measure-${i}`);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
(async () => {
  try {
    await Promise.all(ids.map((ptyId) => client.spawn({ ptyId, command: "cat", cwd: root, cols: 80, rows: 24, agent: "claude" })));
    // A dense screen is the worst normal 80x24 cell payload; a dim placeholder and inverse cursor exercise attributes.
    const text = "\x1b[H\x1b[2J" + Array.from({ length: 20 }, (_, i) => `row ${i}: ` + "output ".repeat(9)).join("\r\n") +
      "\r\n" + "─".repeat(60) + "\r\n❯ \x1b[7mT\x1b[0m\x1b[2mype a message\x1b[0m\r\n" + "─".repeat(60) + "\r\n esc to interrupt";
    // cat echoes, so write output through a shell printf instead of PTY input canonical processing.
    for (const id of ids) {
      await client.kill(id);
      await client.spawn({ ptyId: id, command: `printf '%s' '${text.replace(/'/g, "'\\''")}'; exec cat`,
        cwd: root, cols: 80, rows: 24, agent: "claude" });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const get = (ptyId) => client.request({ id: 0, type: "snapshot", ptyId });
    const snapshots = await Promise.all(ids.map(get));
    const sizes = snapshots.map((snapshot) => Buffer.byteLength(JSON.stringify(snapshot)));
    const rounds = [], evaluated = [];
    for (let round = 0; round < 100; round++) {
      const started = performance.now();
      const batch = await Promise.all(ids.map(get));
      rounds.push(performance.now() - started);
      const evalStart = performance.now();
      for (const snapshot of batch) { snapshotHold(snapshot); snapshotBusy(snapshot); }
      evaluated.push(performance.now() - evalStart);
    }
    console.log(JSON.stringify({ panes: ids.length, geometry: "80x24", rounds: 100,
      snapshotBytes: { median: percentile(sizes, .5), max: Math.max(...sizes), total: sizes.reduce((a, b) => a + b, 0) },
      roundTrip30Ms: { median: percentile(rounds, .5), p95: percentile(rounds, .95) },
      evaluateHoldBusy30Ms: { median: percentile(evaluated, .5), p95: percentile(evaluated, .95) },
      node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch,
    }, null, 2));
  } finally {
    const status = await client.hostStatus().catch(() => ({}));
    await client.shutdown().catch(() => {});
    if (status.pid) await waitForExit(status.pid, 5_000);
    rmSync(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
