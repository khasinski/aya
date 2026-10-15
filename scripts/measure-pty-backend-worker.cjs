const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const [target, home, mode] = process.argv.slice(2);
Object.assign(process.env, { AYA_HOME: home, HOME: home, SHELL: "/bin/sh", PATH: "/usr/bin:/bin", LANG: "C", CODEX_HOME: path.join(home, "codex") });
const { PtyHostClient } = require(path.join(target, "dist-electron/pty-host-client.js"));
const client = new PtyHostClient(path.join(target, "dist-electron/pty-host.js"));
const ready = new Set(), sequences = new Map(), carry = new Map(), input = new Map(), outputMs = [];
let outputBytes = 0;
client.attachWebContents({ isDestroyed: () => false, send(_channel, event) {
  if (event.type !== "data") return;
  outputBytes += Buffer.byteLength(event.chunk);
  const text = (carry.get(event.ptyId) || "") + event.chunk;
  if (text.includes(`BENCH_READY:${event.ptyId}`)) ready.add(event.ptyId);
  for (const m of text.matchAll(/BENCH_OUT:(p-\d+):(\d+):(\d+)\r?\n/g)) {
    if (Number(m[2]) <= (sequences.get(m[1]) || 0)) continue;
    sequences.set(m[1], Number(m[2]));
    outputMs.push(Number(process.hrtime.bigint() - BigInt(m[3])) / 1e6);
  }
  for (const m of text.matchAll(/BENCH_PONG:(p-\d+):(\d+)\r?\n/g)) input.get(`${m[1]}:${m[2]}`)?.();
  carry.set(event.ptyId, text.slice(-512));
} });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) { const deadline = Date.now() + 15000; while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await sleep(2); } }
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const rss = pid => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
let hostPid;
(async () => {
  try {
    const child = path.join(__dirname, "measure-pty-backend-child.cjs");
    const started = process.hrtime.bigint();
    await Promise.all(Array.from({ length: 25 }, (_, i) => client.spawn({ ptyId: `p-${i}`, agent: "custom", command: `${quote(process.execPath)} ${quote(child)} p-${i} ${mode}`,
      cwd: home, cols: 80, rows: 24 })));
    await until(() => ready.size === 25, "25 panes did not become ready");
    const spawnReadyMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Active panes fill the rolling buffers; idle panes produce no periodic output.
    await sleep(mode === "active" ? 6500 : 2000);
    const status = await client.hostStatus(), samples = []; hostPid = status.pid;
    for (let i = 0; i < 3; i++) {
      samples.push({ hostRssKiB: rss(status.pid), mainRssKiB: process.memoryUsage().rss / 1024, ownerRssKiB: status.owner ? rss(status.owner.pid) : 0 });
      await sleep(250);
    }
    const roundTripMs = [];
    for (let repeat = 0; repeat < 4; repeat++) for (let i = 0; i < 25; i++) {
      const key = `p-${i}:${repeat}`, start = process.hrtime.bigint(); let received;
      input.set(key, () => { if (received === undefined) received = Number(process.hrtime.bigint() - start) / 1e6; });
      if (!(await client.write(`p-${i}`, `BENCH_IN:${repeat}\n`))) throw new Error("Benchmark input was refused");
      await until(() => received !== undefined, "Benchmark reply did not arrive");
      roundTripMs.push(received); input.delete(key);
    }
    console.log(JSON.stringify({ target, mode, panes: 25, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node,
      spawnReadyMs, outputBytes, samples, roundTripMs, outputMs }));
  } finally {
    await client.shutdown(); client.dispose();
    if (hostPid) await until(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } }, "Benchmark host did not exit");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
